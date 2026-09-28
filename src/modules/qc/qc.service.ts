import type { Order, Prisma, PrismaClient } from "../../generated/prisma/client";
import { OrderEventType, QcOutcome } from "../../generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { canSubmitQcDecision, isValidReworkTarget, nextStationAfter } from "../../lib/workflow";
import { assertNotArchived, assertOrderItemsBelongToOrder, getOrderOrThrow } from "../orders/orders.service";
import { assertActiveQcRejectionReason } from "../qcRejectionReasons/qcRejectionReasons.service";
import { publishOrderEvent } from "../../lib/eventBus";

function deriveState(order: Order) {
  return {
    status: order.status,
    currentStationId: order.currentStationId,
    isCheckedIn: order.isCheckedIn,
  };
}

export interface QcDecisionInput {
  outcome: QcOutcome;
  targetStationId?: string;
  rejectionReasonId?: string;
  reason?: string;
  notes?: string;
  orderItemIds?: string[];
}

export async function submitQcDecision(
  prisma: PrismaClient,
  orderId: string,
  actorUserId: string,
  input: QcDecisionInput,
) {
  const order = await getOrderOrThrow(prisma, orderId);
  assertNotArchived(order);
  const stations = await prisma.station.findMany();
  const check = canSubmitQcDecision(deriveState(order), stations);
  if (!check.ok) throw new ConflictError(check.reason);

  const checkpoint = stations.find((s) => s.id === order.currentStationId)!;

  let targetStation: (typeof stations)[number] | undefined;
  if (input.outcome === QcOutcome.REWORK) {
    targetStation = stations.find((s) => s.id === input.targetStationId);
    const targetCheck = isValidReworkTarget(checkpoint, targetStation);
    if (!targetCheck.ok) throw new ValidationError(targetCheck.reason);
    if (input.rejectionReasonId) {
      await assertActiveQcRejectionReason(prisma, input.rejectionReasonId);
    }
    if (input.orderItemIds) {
      await assertOrderItemsBelongToOrder(prisma, orderId, input.orderItemIds);
    }
  }

  const next = nextStationAfter(stations, checkpoint.id);

  const result = await prisma.$transaction(async (tx) => {
    const openVisit = await tx.stationVisit.findFirst({
      where: { orderId, stationId: checkpoint.id, outgoingAt: null },
      orderBy: { sequenceNo: "desc" },
    });
    if (!openVisit) {
      throw new ConflictError(`No open visit found at ${checkpoint.name} for this order.`);
    }

    await tx.stationVisit.update({
      where: { id: openVisit.id },
      data: { outgoingAt: new Date(), outgoingByUserId: actorUserId },
    });

    const review = await tx.qcReview.create({
      data: {
        orderId,
        stationVisitId: openVisit.id,
        outcome: input.outcome,
        reviewedByUserId: actorUserId,
        notes: input.notes,
      },
    });

    if (input.outcome === QcOutcome.APPROVED) {
      await tx.order.update({
        where: { id: orderId },
        data: { isCheckedIn: false, currentStationId: next ? next.id : checkpoint.id },
      });

      const message = next
        ? `${checkpoint.name} approved; order now expected at ${next.name}.`
        : `${checkpoint.name} approved; awaiting delivery outcome.`;
      await tx.orderEvent.create({
        data: {
          orderId,
          type: OrderEventType.QC_DECISION,
          stationId: checkpoint.id,
          actorUserId,
          message,
        },
      });

      return { kind: "approved" as const, message };
    }

    const target = targetStation!;
    const route = await tx.reworkRoute.create({
      data: {
        orderId,
        qcReviewId: review.id,
        targetStationId: target.id,
        fromStationId: checkpoint.id,
        rejectionReasonId: input.rejectionReasonId,
        reason: input.reason,
      },
    });
    if (input.orderItemIds) {
      await tx.reworkRouteItem.createMany({
        data: input.orderItemIds.map((orderItemId) => ({ reworkRouteId: route.id, orderItemId })),
      });
    }

    // Pin the order back to whoever last received it at the target station — same
    // assignedWorkerUserId field the admin station-override uses — so the rework surfaces
    // directly against the worker who originally handled it there, not just the station queue
    // at large. Only pins if that person is still active and still assigned to that station;
    // otherwise leaves it unpinned (any worker there can pick it up), same invariant
    // overrideStation enforces.
    const priorVisit = await tx.stationVisit.findFirst({
      where: { orderId, stationId: target.id, receivedByUserId: { not: null } },
      orderBy: { sequenceNo: "desc" },
    });
    let reworkWorker: { id: string; name: string } | null = null;
    if (priorVisit?.receivedByUserId) {
      const priorWorker = await tx.user.findUnique({ where: { id: priorVisit.receivedByUserId } });
      if (priorWorker?.isActive && priorWorker.assignedStationId === target.id) {
        reworkWorker = { id: priorWorker.id, name: priorWorker.name };
      }
    }

    await tx.order.update({
      where: { id: orderId },
      data: { isCheckedIn: false, currentStationId: target.id, assignedWorkerUserId: reworkWorker?.id ?? null },
    });

    const decisionMessage = `${checkpoint.name} sent order back for rework${input.reason ? `: ${input.reason}` : ""}.`;
    const routeMessage = `Rework routed to ${target.name}${reworkWorker ? ` and pinned to ${reworkWorker.name}` : ""}.`;
    await tx.orderEvent.create({
      data: {
        orderId,
        type: OrderEventType.QC_DECISION,
        stationId: checkpoint.id,
        actorUserId,
        message: decisionMessage,
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId,
        type: OrderEventType.REWORK_ROUTED,
        stationId: target.id,
        actorUserId,
        message: routeMessage,
        metadata: { assignedWorkerUserId: reworkWorker?.id ?? null },
      },
    });

    return {
      kind: "rework" as const,
      decisionMessage,
      routeMessage,
      targetStationId: target.id,
      targetStationName: target.name,
    };
  });

  const now = new Date().toISOString();
  if (result.kind === "approved") {
    publishOrderEvent({
      orderId,
      orderNumber: order.orderNumber,
      type: OrderEventType.QC_DECISION,
      stationId: checkpoint.id,
      stationName: checkpoint.name,
      message: result.message,
      actorUserId,
      createdAt: now,
    });
  } else {
    publishOrderEvent({
      orderId,
      orderNumber: order.orderNumber,
      type: OrderEventType.QC_DECISION,
      stationId: checkpoint.id,
      stationName: checkpoint.name,
      message: result.decisionMessage,
      actorUserId,
      createdAt: now,
    });
    publishOrderEvent({
      orderId,
      orderNumber: order.orderNumber,
      type: OrderEventType.REWORK_ROUTED,
      stationId: result.targetStationId,
      stationName: result.targetStationName,
      message: result.routeMessage,
      actorUserId,
      createdAt: now,
    });
  }

  return getOrderOrThrow(prisma, orderId);
}

function idNameSlugSummary(entity: { id: string; name: string; slug: string } | null | undefined) {
  return entity ? { id: entity.id, name: entity.name, slug: entity.slug } : null;
}

/** Every QC decision ever recorded for an order, newest first — outcome, notes, reviewer,
 * which checkpoint station it happened at (resolved via stationVisitId, which has no Prisma
 * relation — same "plain string, batch-resolve" convention as OrderEvent.actorUserId), and,
 * for REWORK outcomes, the associated ReworkRoute detail (target station, reason, category). */
export async function listQcReviewsForOrder(prisma: PrismaClient, orderId: string) {
  await getOrderOrThrow(prisma, orderId);

  const reviews = await prisma.qcReview.findMany({ where: { orderId }, orderBy: { createdAt: "desc" } });

  const actorIds = [...new Set(reviews.map((r) => r.reviewedByUserId))];
  const actors = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, name: true, role: { select: { name: true } } },
  });
  const actorById = new Map(actors.map((a) => [a.id, { id: a.id, name: a.name, roleName: a.role.name }]));

  const visitIds = [...new Set(reviews.map((r) => r.stationVisitId))];
  const visits = await prisma.stationVisit.findMany({
    where: { id: { in: visitIds } },
    include: { station: { select: { id: true, name: true, slug: true } } },
  });
  const visitById = new Map(visits.map((v) => [v.id, v]));

  const reviewIds = reviews.map((r) => r.id);
  const reworkRoutes = await prisma.reworkRoute.findMany({
    where: { qcReviewId: { in: reviewIds } },
    include: {
      targetStation: { select: { id: true, name: true, slug: true } },
      rejectionReason: { select: { id: true, name: true, slug: true } },
      items: {
        include: {
          orderItem: {
            include: {
              product: { select: { id: true, name: true } },
              colorLining: { select: { id: true, label: true } },
            },
          },
        },
      },
    },
  });
  const reworkRouteByReviewId = new Map(reworkRoutes.map((rr) => [rr.qcReviewId, rr]));

  return reviews.map((review) => {
    const rework = reworkRouteByReviewId.get(review.id);
    return {
      id: review.id,
      orderId: review.orderId,
      outcome: review.outcome,
      station: idNameSlugSummary(visitById.get(review.stationVisitId)?.station),
      notes: review.notes,
      reviewedBy: actorById.get(review.reviewedByUserId) ?? { id: review.reviewedByUserId, name: "Unknown", roleName: null },
      createdAt: review.createdAt,
      rework: rework
        ? {
            targetStation: idNameSlugSummary(rework.targetStation)!,
            reason: rework.reason,
            rejectionReason: rework.rejectionReason,
            items: rework.items.map((ri) => ({
              id: ri.orderItem.id,
              itemNo: ri.orderItem.itemNo,
              product: ri.orderItem.product,
              colorLining: ri.orderItem.colorLining,
              quantity: ri.orderItem.quantity,
            })),
          }
        : null,
    };
  });
}

export interface QcReviewsForUserFilter {
  outcome?: QcOutcome;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

/** A single QC reviewer's own decision history across every order they've reviewed,
 * newest first — the "which orders did I flag, and why" view. Same per-row shape as
 * listQcReviewsForOrder (station, notes, rework detail) plus which order each row
 * belongs to, since this spans many orders instead of being scoped to one. */
export async function listQcReviewsForUser(prisma: PrismaClient, userId: string, filter: QcReviewsForUserFilter) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: { select: { name: true } } },
  });
  if (!user) throw new NotFoundError("User not found");

  const where: Prisma.QcReviewWhereInput = { reviewedByUserId: userId };
  if (filter.outcome) where.outcome = filter.outcome;
  if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  }

  const [reviews, total] = await prisma.$transaction([
    prisma.qcReview.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    prisma.qcReview.count({ where }),
  ]);

  const orderIds = [...new Set(reviews.map((r) => r.orderId))];
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, orderNumber: true },
  });
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const visitIds = [...new Set(reviews.map((r) => r.stationVisitId))];
  const visits = await prisma.stationVisit.findMany({
    where: { id: { in: visitIds } },
    include: { station: { select: { id: true, name: true, slug: true } } },
  });
  const visitById = new Map(visits.map((v) => [v.id, v]));

  const reviewIds = reviews.map((r) => r.id);
  const reworkRoutes = await prisma.reworkRoute.findMany({
    where: { qcReviewId: { in: reviewIds } },
    include: {
      targetStation: { select: { id: true, name: true, slug: true } },
      rejectionReason: { select: { id: true, name: true, slug: true } },
      items: {
        include: {
          orderItem: {
            include: {
              product: { select: { id: true, name: true } },
              colorLining: { select: { id: true, label: true } },
            },
          },
        },
      },
    },
  });
  const reworkRouteByReviewId = new Map(reworkRoutes.map((rr) => [rr.qcReviewId, rr]));

  const reviewedBy = { id: user.id, name: user.name, roleName: user.role.name };

  const items = reviews.map((review) => {
    const rework = reworkRouteByReviewId.get(review.id);
    return {
      id: review.id,
      order: orderById.get(review.orderId) ?? { id: review.orderId, orderNumber: "Unknown" },
      outcome: review.outcome,
      station: idNameSlugSummary(visitById.get(review.stationVisitId)?.station),
      notes: review.notes,
      reviewedBy,
      createdAt: review.createdAt,
      rework: rework
        ? {
            targetStation: idNameSlugSummary(rework.targetStation)!,
            reason: rework.reason,
            rejectionReason: rework.rejectionReason,
            items: rework.items.map((ri) => ({
              id: ri.orderItem.id,
              itemNo: ri.orderItem.itemNo,
              product: ri.orderItem.product,
              colorLining: ri.orderItem.colorLining,
              quantity: ri.orderItem.quantity,
            })),
          }
        : null,
    };
  });

  return { items, page: filter.page, pageSize: filter.pageSize, total };
}

export interface QcReportFilter {
  from?: Date;
  to?: Date;
}

/** Aggregate QC pass/rework metrics — total reviews, rework rate, and rework counts broken
 * down by which station the rework was routed to (i.e. whose work needed redoing) and by
 * rejection-reason category. Uses Prisma groupBy, not raw SQL, since there's no date-bucket
 * trunc involved here (unlike getSalesReport) — just a plain date-range filter. */
export async function getQcReport(prisma: PrismaClient, filter: QcReportFilter) {
  const reviewWhere = {
    ...(filter.from || filter.to
      ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
  };

  const outcomeCounts = await prisma.qcReview.groupBy({ by: ["outcome"], where: reviewWhere, _count: true });
  const approvedCount = outcomeCounts.find((o) => o.outcome === QcOutcome.APPROVED)?._count ?? 0;
  const reworkCount = outcomeCounts.find((o) => o.outcome === QcOutcome.REWORK)?._count ?? 0;
  const totalReviews = approvedCount + reworkCount;

  const routeWhere = {
    ...(filter.from || filter.to
      ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
  };

  const byStationRaw = await prisma.reworkRoute.groupBy({
    by: ["targetStationId"],
    where: routeWhere,
    _count: true,
    orderBy: { _count: { targetStationId: "desc" } },
  });
  const stationIds = byStationRaw.map((r) => r.targetStationId);
  const stations = await prisma.station.findMany({ where: { id: { in: stationIds } } });
  const stationById = new Map(stations.map((s) => [s.id, s]));
  const byStation = byStationRaw.map((r) => ({
    station: idNameSlugSummary(stationById.get(r.targetStationId))!,
    reworkCount: r._count,
  }));

  const byReasonRaw = await prisma.reworkRoute.groupBy({
    by: ["rejectionReasonId"],
    where: routeWhere,
    _count: true,
    orderBy: { _count: { rejectionReasonId: "desc" } },
  });
  const reasonIds = byReasonRaw.map((r) => r.rejectionReasonId).filter((id): id is string => id !== null);
  const reasons = await prisma.qcRejectionReason.findMany({ where: { id: { in: reasonIds } } });
  const reasonById = new Map(reasons.map((r) => [r.id, r]));
  const byRejectionReason = byReasonRaw.map((r) => ({
    rejectionReason: r.rejectionReasonId ? idNameSlugSummary(reasonById.get(r.rejectionReasonId)) : null,
    reworkCount: r._count,
  }));

  return {
    from: filter.from ?? null,
    to: filter.to ?? null,
    totalReviews,
    approvedCount,
    reworkCount,
    reworkRatePercent: totalReviews > 0 ? (reworkCount / totalReviews) * 100 : 0,
    byStation,
    byRejectionReason,
  };
}
