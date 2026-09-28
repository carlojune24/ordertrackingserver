import type { Order, PrismaClient } from "../../generated/prisma/client";
import { OrderEventType, ReplacementStatus, ReturnOutcome } from "../../generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { publishOrderEvent } from "../../lib/eventBus";
import { deleteUploadedImageIfLocal, saveUploadedImage } from "../../lib/imageUpload";
import { canIssueReplacement, canSubmitReturnDecision, firstStation } from "../../lib/workflow";
import { assertNotArchived, assertOrderItemsBelongToOrder, getOrderOrThrow } from "../orders/orders.service";

function deriveState(order: Order) {
  return { status: order.status, currentStationId: order.currentStationId, isCheckedIn: order.isCheckedIn };
}

export interface ReturnDecisionInput {
  outcome: ReturnOutcome;
  orderItemIds?: string[];
  notes?: string;
}

export async function submitReturnDecision(
  prisma: PrismaClient,
  orderId: string,
  actorUserId: string,
  input: ReturnDecisionInput,
) {
  const order = await getOrderOrThrow(prisma, orderId);
  assertNotArchived(order);
  const stations = await prisma.station.findMany();
  const check = canSubmitReturnDecision(deriveState(order), stations);
  if (!check.ok) throw new ConflictError(check.reason);

  const returnStation = stations.find((s) => s.id === order.currentStationId)!;
  const qcStation = stations.find((s) => s.isQcCheckpoint && s.isActive);
  if (input.outcome === ReturnOutcome.SEND_TO_QC && !qcStation) {
    throw new ValidationError("No active QC station is configured to send this order to.");
  }
  if (input.outcome === ReturnOutcome.FOR_REPLACEMENT) {
    await assertOrderItemsBelongToOrder(prisma, orderId, input.orderItemIds!);
  }

  const message = await prisma.$transaction(async (tx) => {
    const openVisit = await tx.stationVisit.findFirst({
      where: { orderId, stationId: returnStation.id, outgoingAt: null },
      orderBy: { sequenceNo: "desc" },
    });
    if (!openVisit) throw new ConflictError(`No open visit found at ${returnStation.name} for this order.`);

    await tx.stationVisit.update({
      where: { id: openVisit.id },
      data: { outgoingAt: new Date(), outgoingByUserId: actorUserId },
    });
    await tx.returnReview.create({
      data: { orderId, stationVisitId: openVisit.id, outcome: input.outcome, decidedByUserId: actorUserId, notes: input.notes },
    });

    // Any flag left by an earlier decision on this same return is replaced by this one.
    await tx.orderItem.updateMany({
      where: { orderId, replacementStatus: ReplacementStatus.FLAGGED },
      data: { replacementStatus: ReplacementStatus.NONE, replacementFlaggedAt: null },
    });

    let text: string;
    if (input.outcome === ReturnOutcome.SEND_TO_QC) {
      await tx.order.update({ where: { id: orderId }, data: { isCheckedIn: false, currentStationId: qcStation!.id } });
      text = `${returnStation.name} sent the returned order to ${qcStation!.name}.`;
    } else {
      await tx.orderItem.updateMany({
        where: { orderId, id: { in: input.orderItemIds! } },
        data: { replacementStatus: ReplacementStatus.FLAGGED, replacementFlaggedAt: new Date() },
      });
      await tx.order.update({ where: { id: orderId }, data: { isCheckedIn: false } });
      text = `${returnStation.name} flagged ${input.orderItemIds!.length} item(s) for replacement; awaiting issue.`;
    }

    await tx.orderEvent.create({
      data: { orderId, type: OrderEventType.RETURN_DECISION, stationId: returnStation.id, actorUserId, message: text },
    });
    return text;
  });

  publishOrderEvent({
    orderId,
    orderNumber: order.orderNumber,
    type: OrderEventType.RETURN_DECISION,
    stationId: returnStation.id,
    stationName: returnStation.name,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  return getOrderOrThrow(prisma, orderId);
}

/** Loops the SAME order back to the first station for the items flagged FOR_REPLACEMENT — no new
 * order, same QR and timeline. The next StationVisits just take the next sequenceNo per station. */
export async function issueReplacement(prisma: PrismaClient, orderId: string, actorUserId: string, notes?: string) {
  const order = await getOrderOrThrow(prisma, orderId);
  assertNotArchived(order);
  const stations = await prisma.station.findMany();
  const check = canIssueReplacement(deriveState(order), stations);
  if (!check.ok) throw new ConflictError(check.reason);

  const flagged = await prisma.orderItem.findMany({
    where: { orderId, replacementStatus: ReplacementStatus.FLAGGED },
    select: { id: true, itemNo: true },
    orderBy: { itemNo: "asc" },
  });
  if (flagged.length === 0) {
    throw new ConflictError("No items on this order are flagged for replacement.");
  }
  const first = firstStation(stations);
  if (!first) throw new ValidationError("No active stations are configured — the order cannot be routed anywhere.");

  const message = `Replacement issued for item(s) ${flagged.map((i) => i.itemNo).join(", ")}; order looped back to ${first.name}${notes ? `: ${notes}` : ""}.`;
  await prisma.$transaction(async (tx) => {
    await tx.orderItem.updateMany({
      where: { orderId, replacementStatus: ReplacementStatus.FLAGGED },
      data: { replacementStatus: ReplacementStatus.ISSUED, replacementIssuedAt: new Date() },
    });
    await tx.order.update({
      where: { id: orderId },
      data: { currentStationId: first.id, isCheckedIn: false, assignedWorkerUserId: null },
    });
    await tx.orderEvent.create({
      data: { orderId, type: OrderEventType.REPLACEMENT_ISSUED, stationId: first.id, actorUserId, message },
    });
  });

  publishOrderEvent({
    orderId,
    orderNumber: order.orderNumber,
    type: OrderEventType.REPLACEMENT_ISSUED,
    stationId: first.id,
    stationName: first.name,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  return getOrderOrThrow(prisma, orderId);
}

async function getReturnReviewOrThrow(prisma: PrismaClient, orderId: string, reviewId: string) {
  const review = await prisma.returnReview.findUnique({ where: { id: reviewId }, include: { images: true } });
  if (!review || review.orderId !== orderId) throw new NotFoundError("Return review not found");
  return review;
}

/** Attaches photo evidence to a Return station decision — for record purposes, e.g. the
 * condition of the returned item or a defect close-up. Separate from the decision itself
 * (submitReturnDecision) since inspection often continues after the outcome is already
 * recorded. */
export async function addReturnReviewImage(prisma: PrismaClient, orderId: string, reviewId: string, url: string) {
  await getReturnReviewOrThrow(prisma, orderId, reviewId);
  await prisma.returnReviewImage.create({ data: { returnReviewId: reviewId, url } });
  return getReturnReviewOrThrow(prisma, orderId, reviewId);
}

/** Same as addReturnReviewImage, but the image bytes come from a multipart upload (see
 * returns.routes.ts) instead of an already-hosted url. */
export async function uploadReturnReviewImage(prisma: PrismaClient, orderId: string, reviewId: string, buffer: Buffer) {
  await getReturnReviewOrThrow(prisma, orderId, reviewId); // 404 early, before writing anything to disk
  const { url } = await saveUploadedImage("returns", buffer);
  return addReturnReviewImage(prisma, orderId, reviewId, url);
}

export async function removeReturnReviewImage(prisma: PrismaClient, orderId: string, reviewId: string, imageId: string) {
  await getReturnReviewOrThrow(prisma, orderId, reviewId);
  const image = await prisma.returnReviewImage.findUnique({ where: { id: imageId } });
  if (!image || image.returnReviewId !== reviewId) throw new NotFoundError("Return review image not found");

  await prisma.returnReviewImage.delete({ where: { id: imageId } });
  await deleteUploadedImageIfLocal(image.url);
  return getReturnReviewOrThrow(prisma, orderId, reviewId);
}
