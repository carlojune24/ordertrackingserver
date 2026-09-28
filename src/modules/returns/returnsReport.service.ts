import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { DeliveryOutcomeType, OrderEventType, ReturnOutcome } from "../../generated/prisma/enums";

export interface ReturnsReportFilter {
  from?: Date;
  to?: Date;
  returnReason?: "DEFECT" | "DISSATISFACTION" | "MISSING_OR_LACKING";
  categoryId?: string;
  search?: string;
  page: number;
  pageSize: number;
}

type ReturnStatus = "ON_THE_WAY_BACK" | "AT_RETURN" | "SENT_TO_QC" | "FOR_REPLACEMENT" | "REPLACEMENT_ISSUED" | "CLOSED";

function tally<K>(pairs: [K, number][], keyOf: (k: K) => string) {
  const map = new Map<string, { key: K; total: number }>();
  for (const [key, n] of pairs) {
    const id = keyOf(key);
    const existing = map.get(id);
    if (existing) existing.total += n;
    else map.set(id, { key, total: n });
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

/** "Returned products" report: one row per RETURNED delivery outcome, with aggregate breakdowns
 * for the whole filtered set (not just the current page). Status is derived from what happened
 * to the order after that return — Return station visit, Return decision, replacement issue —
 * bounded by the order's next return, so an earlier return on a twice-returned order reads
 * CLOSED. Return volumes are small, so this batches a few queries and aggregates in JS. */
export async function getReturnsReport(prisma: PrismaClient, filter: ReturnsReportFilter) {
  const orderWhere: Prisma.OrderWhereInput = { isArchived: false };
  if (filter.categoryId) orderWhere.items = { some: { product: { categoryId: filter.categoryId } } };
  if (filter.search) {
    orderWhere.OR = [
      { orderNumber: { contains: filter.search, mode: "insensitive" } },
      { customer: { name: { contains: filter.search, mode: "insensitive" } } },
      { items: { some: { product: { name: { contains: filter.search, mode: "insensitive" } } } } },
    ];
  }

  const where: Prisma.DeliveryOutcomeWhereInput = { outcome: DeliveryOutcomeType.RETURNED, order: orderWhere };
  if (filter.returnReason) where.returnReason = filter.returnReason;
  if (filter.from || filter.to) {
    where.createdAt = { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) };
  }

  const outcomes = await prisma.deliveryOutcome.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          currentStationId: true,
          isCheckedIn: true,
          customer: { select: { id: true, name: true } },
          items: {
            select: {
              id: true,
              itemNo: true,
              quantity: true,
              replacementStatus: true,
              product: { select: { id: true, name: true, category: { select: { id: true, name: true } } } },
              colorLining: { select: { id: true, label: true } },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });

  const orderIds = [...new Set(outcomes.map((o) => o.orderId))];
  const [allOutcomes, reviews, returnVisits, issuedEvents, users] = await Promise.all([
    prisma.deliveryOutcome.findMany({
      where: { orderId: { in: orderIds }, outcome: DeliveryOutcomeType.RETURNED },
      select: { orderId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.returnReview.findMany({ where: { orderId: { in: orderIds } }, orderBy: { createdAt: "asc" } }),
    prisma.stationVisit.findMany({
      where: { orderId: { in: orderIds }, station: { isReturnStation: true } },
      select: { orderId: true, receivedAt: true },
    }),
    prisma.orderEvent.findMany({
      where: { orderId: { in: orderIds }, type: OrderEventType.REPLACEMENT_ISSUED },
      select: { orderId: true, createdAt: true },
    }),
    prisma.user.findMany({
      where: { id: { in: [...new Set(outcomes.map((o) => o.recordedByUserId))] } },
      select: { id: true, name: true, role: { select: { name: true } } },
    }),
  ]);
  const userById = new Map(users.map((u) => [u.id, { id: u.id, name: u.name, roleName: u.role.name }]));

  const rows = outcomes.map((outcome) => {
    const start = outcome.createdAt.getTime();
    const nextReturn = allOutcomes.find((o) => o.orderId === outcome.orderId && o.createdAt.getTime() > start);
    const end = nextReturn ? nextReturn.createdAt.getTime() : Infinity;
    const inWindow = (d: Date | null) => d !== null && d.getTime() > start && d.getTime() < end;

    const review = reviews.filter((r) => r.orderId === outcome.orderId && inWindow(r.createdAt)).pop();
    const received = returnVisits.some((v) => v.orderId === outcome.orderId && inWindow(v.receivedAt));
    const issued = issuedEvents.some((e) => e.orderId === outcome.orderId && inWindow(e.createdAt));

    let status: ReturnStatus;
    if (review?.outcome === ReturnOutcome.SEND_TO_QC) status = "SENT_TO_QC";
    else if (review?.outcome === ReturnOutcome.FOR_REPLACEMENT) status = issued ? "REPLACEMENT_ISSUED" : "FOR_REPLACEMENT";
    else if (received) status = "AT_RETURN";
    else status = "ON_THE_WAY_BACK";
    if (nextReturn && status === "ON_THE_WAY_BACK") status = "CLOSED";

    const items = outcome.order.items.map((item) => ({
      id: item.id,
      itemNo: item.itemNo,
      itemCode: `${outcome.order.orderNumber}-${item.itemNo}`,
      product: { id: item.product.id, name: item.product.name },
      category: item.product.category,
      colorLining: item.colorLining,
      quantity: item.quantity,
      replacementStatus: item.replacementStatus,
    }));

    return {
      deliveryOutcomeId: outcome.id,
      returnedAt: outcome.createdAt,
      order: { id: outcome.order.id, orderNumber: outcome.order.orderNumber, customer: outcome.order.customer },
      items,
      units: items.reduce((sum, i) => sum + i.quantity, 0),
      returnReason: outcome.returnReason,
      returnNote: outcome.returnNote,
      handledBy: userById.get(outcome.recordedByUserId) ?? { id: outcome.recordedByUserId, name: "Unknown", roleName: null },
      courierName: outcome.courierName,
      waybillNumber: outcome.waybillNumber,
      status,
    };
  });

  const byReason = tally(
    rows.filter((r) => r.returnReason).map((r) => [r.returnReason!, 1] as [NonNullable<typeof r.returnReason>, number]),
    (k) => k,
  ).map((e) => ({ reason: e.key, count: e.total }));

  const categoryPairs = rows.flatMap((r) => r.items.map((i) => [i.category, i.quantity] as [{ id: string; name: string }, number]));
  const byCategory = tally(categoryPairs, (c) => c.id).map((e) => ({ category: e.key, units: e.total }));

  const productPairs = rows.flatMap((r) => r.items.map((i) => [i.product, i.quantity] as [{ id: string; name: string }, number]));
  const topProducts = tally(productPairs, (p) => p.id)
    .slice(0, 5)
    .map((e) => ({ product: e.key, units: e.total }));

  const start = (filter.page - 1) * filter.pageSize;
  return {
    from: filter.from ?? null,
    to: filter.to ?? null,
    summary: {
      totalReturns: rows.length,
      totalUnits: rows.reduce((sum, r) => sum + r.units, 0),
      topReason: byReason[0] ?? null,
      topCategory: byCategory[0] ?? null,
    },
    byReason,
    byCategory,
    topProducts,
    page: filter.page,
    pageSize: filter.pageSize,
    total: rows.length,
    items: rows.slice(start, start + filter.pageSize),
  };
}
