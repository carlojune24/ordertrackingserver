import type { Order, Prisma, PrismaClient } from "../../generated/prisma/client";
import { DeliveryOutcomeType, OrderEventType, OrderStatus, ReturnReason } from "../../generated/prisma/enums";
import { ConflictError, ValidationError } from "../../lib/errors";
import { canRecordDeliveryOutcome, lastStation } from "../../lib/workflow";
import { assertNotArchived, getOrderOrThrow } from "../orders/orders.service";
import { publishOrderEvent } from "../../lib/eventBus";

function deriveState(order: Order) {
  return {
    status: order.status,
    currentStationId: order.currentStationId,
    isCheckedIn: order.isCheckedIn,
  };
}

export interface DeliveryOutcomeInput {
  outcome: DeliveryOutcomeType;
  customerConfirmed?: boolean;
  returnReason?: ReturnReason;
  returnNote?: string;
  courierName?: string;
  waybillNumber?: string;
}

export async function recordDeliveryOutcome(
  prisma: PrismaClient,
  orderId: string,
  actorUserId: string,
  input: DeliveryOutcomeInput,
) {
  const order = await getOrderOrThrow(prisma, orderId);
  assertNotArchived(order);
  const stations = await prisma.station.findMany();
  const check = canRecordDeliveryOutcome(deriveState(order), stations);
  if (!check.ok) throw new ConflictError(check.reason);

  // isCheckedIn:false + currentStationId:last is ambiguous on its own — it's the same shape
  // whether the order is still in transit toward the last station (e.g. right after QC
  // approves) or has actually been scanned out there. A closed StationVisit at the last
  // station proves a receive+outgoing punch happened — but after a RETURNED outcome whose
  // responsibleStationId is that same last station, the *previous* pass's closed visit would
  // still satisfy that check before any new scan occurs, so also require the closed visit be
  // newer than the most recent DeliveryOutcome, proving it's from *this* pass, not the last one.
  const last = lastStation(stations)!;
  const [lastVisit, lastOutcome] = await Promise.all([
    prisma.stationVisit.findFirst({ where: { orderId, stationId: last.id }, orderBy: { sequenceNo: "desc" } }),
    prisma.deliveryOutcome.findFirst({ where: { orderId }, orderBy: { createdAt: "desc" } }),
  ]);
  if (!lastVisit?.outgoingAt || (lastOutcome && lastVisit.outgoingAt <= lastOutcome.createdAt)) {
    throw new ConflictError(`Order must be scanned out at ${last.name} before a delivery outcome can be recorded.`);
  }

  // Every return lands at the fixed Return station, which decides QC vs. replacement.
  let returnStation: (typeof stations)[number] | undefined;
  if (input.outcome === DeliveryOutcomeType.RETURNED) {
    returnStation = stations.find((s) => s.isReturnStation && s.isActive);
    if (!returnStation) {
      throw new ValidationError("No active Return station is configured — an order cannot be returned.");
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.deliveryOutcome.create({
      data: {
        orderId,
        outcome: input.outcome,
        customerConfirmed: input.customerConfirmed ?? false,
        returnReason: input.returnReason,
        returnNote: input.returnNote,
        responsibleStationId: returnStation?.id,
        courierName: input.courierName,
        waybillNumber: input.waybillNumber,
        recordedByUserId: actorUserId,
      },
    });

    if (input.outcome === DeliveryOutcomeType.DELIVERED) {
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.DELIVERED, currentStationId: null, isCheckedIn: false },
      });

      const message = input.courierName
        ? `Delivery confirmed by customer via ${input.courierName}${input.waybillNumber ? ` (waybill ${input.waybillNumber})` : ""}.`
        : "Delivery confirmed by customer.";
      await tx.orderEvent.create({
        data: {
          orderId,
          type: OrderEventType.DELIVERY_CONFIRMED,
          actorUserId,
          message,
        },
      });

      return { kind: "delivered" as const, message };
    }

    const target = returnStation!;
    await tx.order.update({
      where: { id: orderId },
      data: { currentStationId: target.id, isCheckedIn: false },
    });

    const message = `Returned to sender (${input.returnReason}); routed to ${target.name} for a return decision.`;
    await tx.orderEvent.create({
      data: {
        orderId,
        type: OrderEventType.RETURNED_TO_SENDER,
        stationId: target.id,
        actorUserId,
        message,
      },
    });

    return { kind: "returned" as const, message, targetStationId: target.id, targetStationName: target.name };
  });

  publishOrderEvent({
    orderId,
    orderNumber: order.orderNumber,
    type: result.kind === "delivered" ? OrderEventType.DELIVERY_CONFIRMED : OrderEventType.RETURNED_TO_SENDER,
    stationId: result.kind === "returned" ? result.targetStationId : null,
    stationName: result.kind === "returned" ? result.targetStationName : null,
    message: result.message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  return getOrderOrThrow(prisma, orderId);
}

export interface DeliveredReportFilter {
  from?: Date;
  to?: Date;
  courierName?: string;
  page: number;
  pageSize: number;
}

/** Paginated, newest-first log of every DELIVERED outcome, with the courier/waybill detail
 * and delivered item lines inlined — the thing GET /orders?status=DELIVERED can't give you,
 * since the general order listing neither includes DeliveryOutcome nor sorts by delivery
 * time. Built for a "delivery station history" screen: what went out, via which courier,
 * when. */
export async function getDeliveredReport(prisma: PrismaClient, filter: DeliveredReportFilter) {
  const where: Prisma.DeliveryOutcomeWhereInput = { outcome: DeliveryOutcomeType.DELIVERED };
  if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  }
  if (filter.courierName) {
    where.courierName = { contains: filter.courierName, mode: "insensitive" };
  }

  const [outcomes, total] = await prisma.$transaction([
    prisma.deliveryOutcome.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            orderDate: true,
            customer: { select: { id: true, name: true } },
            items: {
              select: {
                id: true,
                itemNo: true,
                quantity: true,
                product: { select: { id: true, name: true } },
                colorLining: { select: { id: true, label: true } },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    }),
    prisma.deliveryOutcome.count({ where }),
  ]);

  const actorIds = [...new Set(outcomes.map((o) => o.recordedByUserId))];
  const actors = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, name: true, role: { select: { name: true } } },
  });
  const actorById = new Map(actors.map((a) => [a.id, { id: a.id, name: a.name, roleName: a.role.name }]));

  const items = outcomes.map((outcome) => ({
    deliveryOutcomeId: outcome.id,
    order: {
      id: outcome.order.id,
      orderNumber: outcome.order.orderNumber,
      orderDate: outcome.order.orderDate,
      customer: outcome.order.customer,
    },
    items: outcome.order.items.map((item) => ({
      id: item.id,
      itemNo: item.itemNo,
      itemCode: `${outcome.order.orderNumber}-${item.itemNo}`,
      product: item.product,
      colorLining: item.colorLining,
      quantity: item.quantity,
    })),
    customerConfirmed: outcome.customerConfirmed,
    courierName: outcome.courierName,
    waybillNumber: outcome.waybillNumber,
    deliveredAt: outcome.createdAt,
    recordedBy: actorById.get(outcome.recordedByUserId) ?? { id: outcome.recordedByUserId, name: "Unknown", roleName: null },
  }));

  return {
    from: filter.from ?? null,
    to: filter.to ?? null,
    courierName: filter.courierName ?? null,
    page: filter.page,
    pageSize: filter.pageSize,
    total,
    items,
  };
}
