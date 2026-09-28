import type { Order, PrismaClient } from "../../generated/prisma/client";
import { OrderEventType } from "../../generated/prisma/enums";
import { NotFoundError, ConflictError, ForbiddenError } from "../../lib/errors";
import {
  canLogOutgoing,
  canReceive,
  canReturnForRework,
  nextStationAfter,
  previousStationBefore,
  type OrderWorkflowState,
} from "../../lib/workflow";
import { assertNotArchived, assertOrderItemsBelongToOrder, getOrderOrThrow } from "../orders/orders.service";
import { assertActiveQcRejectionReason } from "../qcRejectionReasons/qcRejectionReasons.service";
import { publishOrderEvent } from "../../lib/eventBus";

function deriveState(order: Order): OrderWorkflowState {
  return {
    status: order.status,
    currentStationId: order.currentStationId,
    isCheckedIn: order.isCheckedIn,
  };
}

async function findOrderByQrTokenOrThrow(prisma: PrismaClient, qrToken: string) {
  const order = await prisma.order.findUnique({ where: { qrToken } });
  if (!order) throw new NotFoundError("No order matches this QR code");
  return order;
}

/** A user with an assignedStationId (a station worker) may only scan at that one station.
 * Users with no assignment (Supervisor, Management, etc.) are unrestricted. */
export async function assertStationAllowed(prisma: PrismaClient, actorUserId: string, stationId: string) {
  const actor = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: { assignedStationId: true, assignedStation: { select: { name: true } } },
  });
  if (actor?.assignedStationId && actor.assignedStationId !== stationId) {
    throw new ForbiddenError(`You are only assigned to scan at ${actor.assignedStation?.name ?? "your assigned station"}.`);
  }
}

export async function receiveAtStation(
  prisma: PrismaClient,
  qrToken: string,
  stationId: string,
  actorUserId: string,
) {
  await assertStationAllowed(prisma, actorUserId, stationId);
  const order = await findOrderByQrTokenOrThrow(prisma, qrToken);
  assertNotArchived(order);
  const stations = await prisma.station.findMany();
  const check = canReceive(deriveState(order), stations, stationId);
  if (!check.ok) throw new ConflictError(check.reason);

  const station = stations.find((s) => s.id === stationId)!;

  const message = await prisma.$transaction(async (tx) => {
    const existingVisits = await tx.stationVisit.count({ where: { orderId: order.id, stationId } });
    const sequenceNo = existingVisits + 1;

    // If this station receipt is the physical arrival of a pending ReworkRoute (QC-flagged or
    // a peer-station rejection targeting this station), link the two: lets logOutgoingAtStation
    // later tell a formal QC rework apart from a plain rejection once this visit closes out.
    const pendingRoute = await tx.reworkRoute.findFirst({
      where: { orderId: order.id, targetStationId: stationId, resultingStationVisitId: null },
      orderBy: { createdAt: "desc" },
    });

    const visit = await tx.stationVisit.create({
      data: {
        orderId: order.id,
        stationId,
        sequenceNo,
        receivedAt: new Date(),
        receivedByUserId: actorUserId,
        isReworkVisit: sequenceNo > 1,
        reworkRouteId: pendingRoute?.id,
      },
    });
    if (pendingRoute) {
      await tx.reworkRoute.update({ where: { id: pendingRoute.id }, data: { resultingStationVisitId: visit.id } });
    }

    await tx.order.update({ where: { id: order.id }, data: { isCheckedIn: true } });

    const message = `Received at ${station.name} (visit #${sequenceNo}).`;
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: OrderEventType.STATION_RECEIVED,
        stationId,
        actorUserId,
        message,
      },
    });

    return message;
  });

  publishOrderEvent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    type: OrderEventType.STATION_RECEIVED,
    stationId,
    stationName: station.name,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  return getOrderOrThrow(prisma, order.id);
}

export interface ReturnForReworkInput {
  rejectionReasonId?: string;
  reason?: string;
  orderItemIds?: string[];
}

/** A regular station rejects the order it just received and sends it back exactly one step
 * — to whichever active station immediately precedes it — instead of logging a normal
 * outgoing scan. Distinct from QC's rework routing (POST /orders/:id/qc-decision), which can
 * target any earlier active dynamic station and always creates a QcReview; this path never
 * does (ReworkRoute.qcReviewId is left null) since no formal QC checkpoint was involved. */
export async function returnForRework(
  prisma: PrismaClient,
  qrToken: string,
  stationId: string,
  actorUserId: string,
  input: ReturnForReworkInput,
) {
  await assertStationAllowed(prisma, actorUserId, stationId);
  const order = await findOrderByQrTokenOrThrow(prisma, qrToken);
  assertNotArchived(order);
  const stations = await prisma.station.findMany();
  const check = canReturnForRework(deriveState(order), stations, stationId);
  if (!check.ok) throw new ConflictError(check.reason);

  const station = stations.find((s) => s.id === stationId)!;
  const previous = previousStationBefore(stations, station.id)!;

  if (input.rejectionReasonId) {
    await assertActiveQcRejectionReason(prisma, input.rejectionReasonId);
  }
  if (input.orderItemIds) {
    await assertOrderItemsBelongToOrder(prisma, order.id, input.orderItemIds);
  }

  const message = await prisma.$transaction(async (tx) => {
    const openVisit = await tx.stationVisit.findFirst({
      where: { orderId: order.id, stationId, outgoingAt: null },
      orderBy: { sequenceNo: "desc" },
    });
    if (!openVisit) {
      throw new ConflictError(`No open visit found at ${station.name} to reject for rework.`);
    }

    await tx.stationVisit.update({
      where: { id: openVisit.id },
      data: { outgoingAt: new Date(), outgoingByUserId: actorUserId },
    });

    const route = await tx.reworkRoute.create({
      data: {
        orderId: order.id,
        targetStationId: previous.id,
        fromStationId: station.id,
        rejectionReasonId: input.rejectionReasonId,
        reason: input.reason,
      },
    });
    if (input.orderItemIds) {
      await tx.reworkRouteItem.createMany({
        data: input.orderItemIds.map((orderItemId) => ({ reworkRouteId: route.id, orderItemId })),
      });
    }

    await tx.order.update({
      where: { id: order.id },
      data: { isCheckedIn: false, currentStationId: previous.id },
    });

    const rejectMessage = `${station.name} rejected the order for rework${input.reason ? `: ${input.reason}` : ""}.`;
    const routeMessage = `Rework routed to ${previous.name}.`;
    await tx.orderEvent.create({
      data: { orderId: order.id, type: OrderEventType.STATION_REJECTED, stationId, actorUserId, message: rejectMessage },
    });
    await tx.orderEvent.create({
      data: { orderId: order.id, type: OrderEventType.REWORK_ROUTED, stationId: previous.id, actorUserId, message: routeMessage },
    });

    return { rejectMessage, routeMessage };
  });

  const now = new Date().toISOString();
  publishOrderEvent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    type: OrderEventType.STATION_REJECTED,
    stationId,
    stationName: station.name,
    message: message.rejectMessage,
    actorUserId,
    createdAt: now,
  });
  publishOrderEvent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    type: OrderEventType.REWORK_ROUTED,
    stationId: previous.id,
    stationName: previous.name,
    message: message.routeMessage,
    actorUserId,
    createdAt: now,
  });

  return getOrderOrThrow(prisma, order.id);
}

export async function logOutgoingAtStation(
  prisma: PrismaClient,
  qrToken: string,
  stationId: string,
  actorUserId: string,
) {
  await assertStationAllowed(prisma, actorUserId, stationId);
  const order = await findOrderByQrTokenOrThrow(prisma, qrToken);
  assertNotArchived(order);
  const stations = await prisma.station.findMany();
  const check = canLogOutgoing(deriveState(order), stations, stationId);
  if (!check.ok) throw new ConflictError(check.reason);

  const station = stations.find((s) => s.id === stationId)!;

  const message = await prisma.$transaction(async (tx) => {
    const openVisit = await tx.stationVisit.findFirst({
      where: { orderId: order.id, stationId, outgoingAt: null },
      orderBy: { sequenceNo: "desc" },
    });
    if (!openVisit) {
      throw new ConflictError(`No open visit found at ${station.name} to log outgoing for.`);
    }

    // A formal QC-flagged revisit (ReworkRoute.qcReviewId set, vs. null for a plain
    // peer-station rejection) skips straight back to QC once this station finishes, instead of
    // walking the normal remaining sequence — only this station's work was flagged, so there's
    // nothing for the stations in between to redo.
    let next = nextStationAfter(stations, stationId);
    if (openVisit.reworkRouteId) {
      const route = await tx.reworkRoute.findUnique({ where: { id: openVisit.reworkRouteId } });
      if (route?.qcReviewId) {
        const qcStation = stations.find((s) => s.isQcCheckpoint && s.isActive);
        if (qcStation) next = qcStation;
      }
    }

    await tx.stationVisit.update({
      where: { id: openVisit.id },
      data: { outgoingAt: new Date(), outgoingByUserId: actorUserId },
    });

    await tx.order.update({
      where: { id: order.id },
      data: { isCheckedIn: false, currentStationId: next ? next.id : stationId },
    });

    const message = next
      ? `Outgoing logged at ${station.name}; order now expected at ${next.name}.`
      : `Outgoing logged at ${station.name}; awaiting delivery outcome.`;
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: OrderEventType.STATION_OUTGOING,
        stationId,
        actorUserId,
        message,
      },
    });

    return message;
  });

  publishOrderEvent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    type: OrderEventType.STATION_OUTGOING,
    stationId,
    stationName: station.name,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  return getOrderOrThrow(prisma, order.id);
}

export interface SetItemProgressInput {
  orderItemId: string;
  isFinished: boolean;
}

/** Per-item "finished at this station" checklist toggle — informational only, does not gate
 * logOutgoingAtStation (workflow.ts is unchanged; the order still advances as one unit exactly
 * as before). Scoped to the order's currently OPEN StationVisit at this station, so a rework
 * revisit automatically starts every item back at "not finished" — the new StationVisit row
 * has no progress rows referencing it yet, no explicit reset needed. */
export async function setItemStationProgress(
  prisma: PrismaClient,
  qrToken: string,
  stationId: string,
  actorUserId: string,
  input: SetItemProgressInput,
) {
  await assertStationAllowed(prisma, actorUserId, stationId);
  const order = await findOrderByQrTokenOrThrow(prisma, qrToken);
  assertNotArchived(order);
  await assertOrderItemsBelongToOrder(prisma, order.id, [input.orderItemId]);

  const openVisit = await prisma.stationVisit.findFirst({
    where: { orderId: order.id, stationId, outgoingAt: null },
    orderBy: { sequenceNo: "desc" },
  });
  if (!openVisit) {
    throw new ConflictError("Order is not currently checked in at this station.");
  }

  const progress = await prisma.orderItemStationProgress.upsert({
    where: { orderItemId_stationVisitId: { orderItemId: input.orderItemId, stationVisitId: openVisit.id } },
    create: {
      orderItemId: input.orderItemId,
      stationVisitId: openVisit.id,
      isFinished: input.isFinished,
      finishedAt: input.isFinished ? new Date() : null,
      finishedByUserId: input.isFinished ? actorUserId : null,
    },
    update: {
      isFinished: input.isFinished,
      finishedAt: input.isFinished ? new Date() : null,
      finishedByUserId: input.isFinished ? actorUserId : null,
    },
  });

  return {
    orderItemId: progress.orderItemId,
    stationVisitId: progress.stationVisitId,
    isFinished: progress.isFinished,
    finishedAt: progress.finishedAt,
  };
}
