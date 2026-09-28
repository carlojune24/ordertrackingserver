import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { DeliveryOutcomeType } from "../../generated/prisma/enums";
import { getOrderOrThrow, toOrderDto } from "../orders/orders.service";
import { promoDiscountAmount } from "../../lib/promo";

function stationSummary(station: { id: string; name: string; slug: string } | null) {
  return station ? { id: station.id, name: station.name, slug: station.slug } : null;
}

export async function getOrderTimeline(prisma: PrismaClient, orderId: string) {
  await getOrderOrThrow(prisma, orderId);

  const events = await prisma.orderEvent.findMany({
    where: { orderId },
    include: { station: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "asc" },
  });

  const actorIds = [...new Set(events.map((e) => e.actorUserId))];
  const actors = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, name: true, role: { select: { name: true } } },
  });
  const actorById = new Map(actors.map((a) => [a.id, { id: a.id, name: a.name, roleName: a.role.name }]));

  return events.map((event) => ({
    id: event.id,
    type: event.type,
    station: stationSummary(event.station),
    message: event.message,
    metadata: event.metadata,
    createdAt: event.createdAt,
    actor: actorById.get(event.actorUserId) ?? { id: event.actorUserId, name: "Unknown", roleName: null },
  }));
}

export async function getOrderReport(prisma: PrismaClient, orderId: string) {
  const order = await getOrderOrThrow(prisma, orderId);

  const stationVisits = await prisma.stationVisit.findMany({
    where: { orderId },
    include: { station: { select: { id: true, name: true, slug: true } } },
    orderBy: [{ createdAt: "asc" }],
  });

  const visitsWithDuration = stationVisits.map((visit) => {
    const { station, ...rest } = visit;
    return {
      ...rest,
      station: stationSummary(station),
      durationMs:
        visit.receivedAt && visit.outgoingAt ? visit.outgoingAt.getTime() - visit.receivedAt.getTime() : null,
    };
  });

  const deliveryOutcomes = await prisma.deliveryOutcome.findMany({
    where: { orderId },
    include: { responsibleStation: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "asc" },
  });

  const deliveryOutcomesDto = deliveryOutcomes.map((outcome) => {
    const { responsibleStation, ...rest } = outcome;
    return { ...rest, responsibleStation: stationSummary(responsibleStation) };
  });

  const returnReviews = await prisma.returnReview.findMany({
    where: { orderId },
    orderBy: { createdAt: "asc" },
    include: { images: true },
  });

  const delivered = deliveryOutcomes.find((d) => d.outcome === DeliveryOutcomeType.DELIVERED);
  const turnaroundEndsAt = delivered?.createdAt ?? new Date();
  const totalTurnaroundMs = turnaroundEndsAt.getTime() - order.orderDate.getTime();

  return {
    order: toOrderDto(order),
    stationVisits: visitsWithDuration,
    deliveryOutcomes: deliveryOutcomesDto,
    returnReviews,
    totalTurnaroundMs,
    isComplete: Boolean(delivered),
  };
}

export interface SalesReportFilter {
  from?: Date;
  to?: Date;
  groupBy: "day" | "month";
  includeArchived?: boolean;
}

interface SalesBucketRow {
  period: Date;
  orderCount: number;
  revenue: number;
}

function formatBucketPeriod(period: Date, groupBy: "day" | "month"): string {
  const iso = period.toISOString();
  return groupBy === "month" ? iso.slice(0, 7) + "-01" : iso.slice(0, 10);
}

/** Revenue by orderDate — counts every order placed in range regardless of status
 * (IN_PROGRESS or DELIVERED), since finalPrice is snapshotted at intake and that's when
 * the sale is actually made, not when the order finishes its production run. Uses raw SQL
 * because Prisma's groupBy can't express date_trunc over a computed bucket.
 *
 * Returns both a periodic summary (`buckets` — one row per day/month, for trend charts)
 * and a full transaction-level ledger (`entries` — one row per order in range, oldest
 * first, with a running revenue balance), the way an accounting ledger pairs a summary
 * page with the underlying line items. */
export async function getSalesReport(prisma: PrismaClient, filter: SalesReportFilter) {
  const conditions: Prisma.Sql[] = [];
  if (filter.from) conditions.push(Prisma.sql`o."orderDate" >= ${filter.from}`);
  if (filter.to) conditions.push(Prisma.sql`o."orderDate" <= ${filter.to}`);
  if (!filter.includeArchived) conditions.push(Prisma.sql`o."isArchived" = false`);
  const whereClause = conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;

  const rows = await prisma.$queryRaw<SalesBucketRow[]>(Prisma.sql`
    SELECT
      date_trunc(${filter.groupBy}, t."orderDate") AS period,
      COUNT(*)::int AS "orderCount",
      COALESCE(SUM(t.base - t.promo), 0)::float AS revenue
    FROM (
      SELECT
        o.id,
        o."orderDate",
        SUM((oi."unitPrice" - oi."discountAmount") * oi.quantity) AS base,
        CASE o."promoType"
          WHEN 'PERCENT' THEN ROUND((LEAST(SUM((oi."unitPrice" - oi."discountAmount") * oi.quantity) * o."promoValue" / 100, SUM((oi."unitPrice" - oi."discountAmount") * oi.quantity)))::numeric, 2)
          WHEN 'FIXED' THEN ROUND(LEAST(o."promoValue", SUM((oi."unitPrice" - oi."discountAmount") * oi.quantity))::numeric, 2)
          ELSE 0
        END AS promo
      FROM "orders" o
      JOIN "order_items" oi ON oi."orderId" = o.id
      ${whereClause}
      GROUP BY o.id
    ) t
    GROUP BY period
    ORDER BY period ASC
  `);

  const buckets = rows.map((row) => ({
    period: formatBucketPeriod(row.period, filter.groupBy),
    orderCount: Number(row.orderCount),
    revenue: row.revenue,
    avgOrderValue: row.orderCount > 0 ? row.revenue / row.orderCount : 0,
  }));

  const where: Prisma.OrderWhereInput = {};
  if (filter.from || filter.to) {
    where.orderDate = {};
    if (filter.from) where.orderDate.gte = filter.from;
    if (filter.to) where.orderDate.lte = filter.to;
  }
  if (!filter.includeArchived) where.isArchived = false;

  const orders = await prisma.order.findMany({
    where,
    select: {
      id: true,
      orderNumber: true,
      orderDate: true,
      status: true,
      isArchived: true,
      promoCode: true,
      promoType: true,
      promoValue: true,
      customer: { select: { id: true, name: true } },
      items: {
        select: {
          id: true,
          itemNo: true,
          quantity: true,
          unitPrice: true,
          regularPriceAtOrder: true,
          discountAmount: true,
          discountReason: true,
          product: { select: { id: true, name: true } },
          colorLining: { select: { id: true, label: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: [{ orderDate: "asc" }, { orderNumber: "asc" }],
  });

  let runningBalance = 0;
  const entries = orders.map((order) => {
    const items = order.items.map((item) => {
      const finalPrice = item.unitPrice - item.discountAmount;
      return {
        id: item.id,
        itemNo: item.itemNo,
        itemCode: `${order.orderNumber}-${item.itemNo}`,
        product: item.product,
        colorLining: item.colorLining,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        regularPriceAtOrder: item.regularPriceAtOrder,
        discountAmount: item.discountAmount,
        discountReason: item.discountReason,
        finalPrice,
      };
    });
    const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    const totalDiscount = items.reduce((sum, i) => sum + i.discountAmount * i.quantity, 0);
    const promoDiscount = promoDiscountAmount(subtotal - totalDiscount, order);
    const finalPrice = subtotal - totalDiscount - promoDiscount;
    runningBalance += finalPrice;
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      orderDate: order.orderDate,
      status: order.status,
      isArchived: order.isArchived,
      customer: order.customer,
      items,
      subtotal,
      totalDiscount,
      promoCode: order.promoCode,
      promoDiscount,
      finalPrice,
      runningBalance,
    };
  });

  const totalOrders = buckets.reduce((sum, b) => sum + b.orderCount, 0);
  const totalRevenue = buckets.reduce((sum, b) => sum + b.revenue, 0);

  return {
    from: filter.from ?? null,
    to: filter.to ?? null,
    groupBy: filter.groupBy,
    includeArchived: filter.includeArchived ?? false,
    totalOrders,
    totalRevenue,
    avgOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
    buckets,
    entries,
  };
}
