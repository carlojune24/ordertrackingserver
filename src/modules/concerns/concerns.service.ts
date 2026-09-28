import type { PrismaClient } from "../../generated/prisma/client";
import { OrderConcernType, OrderEventType } from "../../generated/prisma/enums";
import { ConflictError, NotFoundError } from "../../lib/errors";
import { assertNotArchived, getOrderOrThrow } from "../orders/orders.service";
import { assertStationAllowed } from "../scan/scan.service";
import { publishOrderEvent } from "../../lib/eventBus";

const CONCERN_INCLUDE = {
  station: { select: { id: true, name: true, slug: true } },
} as const;

type ConcernWithStation = Awaited<ReturnType<typeof findConcernRow>>;

async function findConcernRow(prisma: PrismaClient, concernId: string) {
  return prisma.orderConcern.findUnique({ where: { id: concernId }, include: CONCERN_INCLUDE });
}

function actorSummary(
  u: { id: string; name: string; role: { name: string } } | undefined,
  fallbackId: string,
) {
  return u ? { id: u.id, name: u.name, roleName: u.role.name } : { id: fallbackId, name: "Unknown", roleName: null };
}

async function toConcernDto(prisma: PrismaClient, concern: NonNullable<ConcernWithStation>) {
  const actorIds = [concern.raisedByUserId, ...(concern.resolvedByUserId ? [concern.resolvedByUserId] : [])];
  const actors = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, name: true, role: { select: { name: true } } },
  });
  const actorById = new Map(actors.map((a) => [a.id, a]));

  return {
    id: concern.id,
    orderId: concern.orderId,
    station: concern.station,
    stationVisitId: concern.stationVisitId,
    type: concern.type,
    message: concern.message,
    raisedBy: actorSummary(actorById.get(concern.raisedByUserId), concern.raisedByUserId),
    isResolved: concern.isResolved,
    resolvedBy: concern.resolvedByUserId
      ? actorSummary(actorById.get(concern.resolvedByUserId), concern.resolvedByUserId)
      : null,
    resolutionNote: concern.resolutionNote,
    resolvedAt: concern.resolvedAt,
    createdAt: concern.createdAt,
  };
}

async function getConcernOrThrow(prisma: PrismaClient, orderId: string, concernId: string) {
  const concern = await findConcernRow(prisma, concernId);
  if (!concern || concern.orderId !== orderId) throw new NotFoundError("Concern not found");
  return concern;
}

export async function raiseConcern(
  prisma: PrismaClient,
  orderId: string,
  actorUserId: string,
  input: { type: OrderConcernType; message: string },
) {
  const order = await getOrderOrThrow(prisma, orderId);
  assertNotArchived(order);
  if (!order.isCheckedIn || !order.currentStationId) {
    throw new ConflictError(
      `Order ${order.orderNumber} must be currently received at a station to raise a ${input.type.toLowerCase()}.`,
    );
  }
  const stationId = order.currentStationId;
  await assertStationAllowed(prisma, actorUserId, stationId);

  const openVisit = await prisma.stationVisit.findFirst({
    where: { orderId, stationId, outgoingAt: null },
    orderBy: { sequenceNo: "desc" },
  });

  const label = input.type === OrderConcernType.CONCERN ? "Concern" : "Clarification";
  const message = `${label} raised: ${input.message}`;

  const concernId = await prisma.$transaction(async (tx) => {
    const created = await tx.orderConcern.create({
      data: {
        orderId,
        stationId,
        stationVisitId: openVisit?.id ?? null,
        type: input.type,
        message: input.message,
        raisedByUserId: actorUserId,
      },
    });
    await tx.orderEvent.create({
      data: { orderId, type: OrderEventType.CONCERN_RAISED, stationId, actorUserId, message },
    });
    return created.id;
  });

  publishOrderEvent({
    orderId,
    orderNumber: order.orderNumber,
    type: OrderEventType.CONCERN_RAISED,
    stationId,
    stationName: order.currentStation?.name ?? null,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  const concern = await getConcernOrThrow(prisma, orderId, concernId);
  return toConcernDto(prisma, concern);
}

export async function listConcerns(prisma: PrismaClient, orderId: string) {
  await getOrderOrThrow(prisma, orderId);
  const concerns = await prisma.orderConcern.findMany({
    where: { orderId },
    include: CONCERN_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  return Promise.all(concerns.map((c) => toConcernDto(prisma, c)));
}

export interface ListAllConcernsFilter {
  isResolved?: boolean;
  page: number;
  pageSize: number;
}

const CONCERN_INCLUDE_WITH_ORDER = {
  station: { select: { id: true, name: true, slug: true } },
  order: { select: { id: true, orderNumber: true, customer: { select: { name: true } } } },
} as const;

/** Concerns across every order, newest first — for a cross-order "open concerns" panel
 * (pass isResolved=false). Batch-resolves actors once for the whole page rather than
 * per-item like toConcernDto/listConcerns, since a global list can be far larger than
 * one order's handful of concerns. */
export async function listAllConcerns(prisma: PrismaClient, filter: ListAllConcernsFilter) {
  const where = filter.isResolved !== undefined ? { isResolved: filter.isResolved } : {};

  const [concerns, total] = await prisma.$transaction([
    prisma.orderConcern.findMany({
      where,
      include: CONCERN_INCLUDE_WITH_ORDER,
      orderBy: { createdAt: "desc" },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    prisma.orderConcern.count({ where }),
  ]);

  const actorIds = [
    ...new Set([
      ...concerns.map((c) => c.raisedByUserId),
      ...concerns.flatMap((c) => (c.resolvedByUserId ? [c.resolvedByUserId] : [])),
    ]),
  ];
  const actors = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, name: true, role: { select: { name: true } } },
  });
  const actorById = new Map(actors.map((a) => [a.id, a]));

  const items = concerns.map((c) => ({
    id: c.id,
    orderId: c.orderId,
    order: { id: c.order.id, orderNumber: c.order.orderNumber, customerName: c.order.customer.name },
    station: c.station,
    stationVisitId: c.stationVisitId,
    type: c.type,
    message: c.message,
    raisedBy: actorSummary(actorById.get(c.raisedByUserId), c.raisedByUserId),
    isResolved: c.isResolved,
    resolvedBy: c.resolvedByUserId ? actorSummary(actorById.get(c.resolvedByUserId), c.resolvedByUserId) : null,
    resolutionNote: c.resolutionNote,
    resolvedAt: c.resolvedAt,
    createdAt: c.createdAt,
  }));

  return { items, total };
}

/** Idempotent — resolving an already-resolved concern is a no-op, same convention as
 * archiveOrder/unarchiveOrder in orders.service.ts. */
export async function resolveConcern(
  prisma: PrismaClient,
  orderId: string,
  concernId: string,
  actorUserId: string,
  input: { resolutionNote?: string },
) {
  const order = await getOrderOrThrow(prisma, orderId);
  assertNotArchived(order);
  const existing = await getConcernOrThrow(prisma, orderId, concernId);
  if (existing.isResolved) return toConcernDto(prisma, existing);

  const message = `${existing.type === OrderConcernType.CONCERN ? "Concern" : "Clarification"} resolved.`;
  await prisma.$transaction(async (tx) => {
    await tx.orderConcern.update({
      where: { id: concernId },
      data: {
        isResolved: true,
        resolvedByUserId: actorUserId,
        resolutionNote: input.resolutionNote ?? null,
        resolvedAt: new Date(),
      },
    });
    await tx.orderEvent.create({
      data: { orderId, type: OrderEventType.CONCERN_RESOLVED, stationId: existing.stationId, actorUserId, message },
    });
  });

  publishOrderEvent({
    orderId,
    orderNumber: order.orderNumber,
    type: OrderEventType.CONCERN_RESOLVED,
    stationId: existing.stationId,
    stationName: existing.station.name,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  const concern = await getConcernOrThrow(prisma, orderId, concernId);
  return toConcernDto(prisma, concern);
}
