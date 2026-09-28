import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { OrderEventType, OrderStatus } from "../../generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { recordActivity } from "../../lib/activityLog";
import { slugify } from "../../lib/slugify";
import { listOrders, toOrderDto } from "../orders/orders.service";

function idNameSlugSummary(entity: { id: string; name: string; slug: string } | null | undefined) {
  return entity ? { id: entity.id, name: entity.name, slug: entity.slug } : null;
}

export async function getStationOrThrow(prisma: PrismaClient, id: string) {
  const station = await prisma.station.findUnique({ where: { id } });
  if (!station) throw new NotFoundError("Station not found");
  return station;
}

const ARRIVAL_EVENT_TYPES: OrderEventType[] = [
  OrderEventType.INTAKE_CREATED,
  OrderEventType.STATION_OUTGOING,
  OrderEventType.REWORK_ROUTED,
  OrderEventType.RETURNED_TO_SENDER,
  OrderEventType.STATION_OVERRIDDEN,
  OrderEventType.RETURN_DECISION,
  OrderEventType.REPLACEMENT_ISSUED,
];

/**
 * The full working queue for a station — every order currently there (pending, in transit
 * toward it, or physically checked in), each annotated with *why* it's here (fresh intake,
 * normal forward hand-off, a regular station's own rejection, a QC reroute, or a customer
 * return) and a proper "since" timestamp for that state. Built from the single most recent
 * of {INTAKE_CREATED, STATION_OUTGOING, REWORK_ROUTED, RETURNED_TO_SENDER} events per order
 * — whichever happened last must be what put the order at its current station, since Order
 * state transitions are sequential. Station queues are small (a handful to a few dozen
 * orders), so this batches everything in a couple of queries and reduces in JS rather than
 * reaching for raw SQL the way the much-larger-scale sales report does.
 */
export async function getStationQueue(prisma: PrismaClient, stationId: string) {
  const station = await getStationOrThrow(prisma, stationId);

  const { items: orders } = await listOrders(prisma, { stationId, page: 1, pageSize: 500 });
  const orderIds = orders.map((o) => o.id);

  const arrivalEvents = await prisma.orderEvent.findMany({
    where: { orderId: { in: orderIds }, type: { in: ARRIVAL_EVENT_TYPES } },
    include: { station: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "desc" },
  });
  const latestEventByOrder = new Map<string, (typeof arrivalEvents)[number]>();
  for (const event of arrivalEvents) {
    if (!latestEventByOrder.has(event.orderId)) latestEventByOrder.set(event.orderId, event);
  }

  const reworkOrderIds = [...latestEventByOrder.entries()]
    .filter(([, event]) => event.type === OrderEventType.REWORK_ROUTED)
    .map(([orderId]) => orderId);
  const reworkRoutes = reworkOrderIds.length
    ? await prisma.reworkRoute.findMany({
        where: { orderId: { in: reworkOrderIds }, targetStationId: stationId },
        include: {
          fromStation: { select: { id: true, name: true, slug: true } },
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
        orderBy: { createdAt: "desc" },
      })
    : [];
  const latestReworkByOrder = new Map<string, (typeof reworkRoutes)[number]>();
  for (const route of reworkRoutes) {
    if (!latestReworkByOrder.has(route.orderId)) latestReworkByOrder.set(route.orderId, route);
  }

  const openVisits = await prisma.stationVisit.findMany({
    where: { orderId: { in: orderIds }, stationId, outgoingAt: null },
  });
  const openVisitByOrder = new Map(openVisits.map((v) => [v.orderId, v]));

  const openVisitIds = openVisits.map((v) => v.id);
  const progressRows = openVisitIds.length
    ? await prisma.orderItemStationProgress.findMany({ where: { stationVisitId: { in: openVisitIds } } })
    : [];
  const progressByKey = new Map(progressRows.map((p) => [`${p.stationVisitId}:${p.orderItemId}`, p.isFinished]));

  const items = orders.map((order) => {
    const event = latestEventByOrder.get(order.id);
    const rework = event?.type === OrderEventType.REWORK_ROUTED ? latestReworkByOrder.get(order.id) : undefined;

    let type: "NEW" | "FORWARD" | "REWORK" | "QC_REROUTE" | "RETURNED" | "OVERRIDE" | "REPLACEMENT" | "REPLACEMENT_PENDING" = "FORWARD";
    let fromStation: { id: string; name: string; slug: string } | null = null;
    let reason: string | null = null;
    let rejectionReason: { id: string; name: string; slug: string } | null = null;
    let defectiveItems: { id: string; itemNo: number; product: { id: string; name: string }; colorLining: { id: string; label: string } | null; quantity: number }[] = [];

    if (event?.type === OrderEventType.INTAKE_CREATED) {
      type = "NEW";
    } else if (event?.type === OrderEventType.STATION_OUTGOING) {
      type = "FORWARD";
      fromStation = event.station;
    } else if (event?.type === OrderEventType.RETURNED_TO_SENDER) {
      type = "RETURNED";
    } else if (event?.type === OrderEventType.REWORK_ROUTED && rework) {
      type = rework.qcReviewId ? "QC_REROUTE" : "REWORK";
      fromStation = rework.fromStation;
      reason = rework.reason;
      rejectionReason = rework.rejectionReason;
      defectiveItems = rework.items.map((ri) => ({
        id: ri.orderItem.id,
        itemNo: ri.orderItem.itemNo,
        product: ri.orderItem.product,
        colorLining: ri.orderItem.colorLining,
        quantity: ri.orderItem.quantity,
      }));
    } else if (event?.type === OrderEventType.STATION_OVERRIDDEN) {
      type = "OVERRIDE";
    } else if (event?.type === OrderEventType.REPLACEMENT_ISSUED) {
      type = "REPLACEMENT";
    } else if (event?.type === OrderEventType.RETURN_DECISION) {
      // Order is still parked at the station the decision was made at => waiting on replacement;
      // otherwise it was sent onward (to QC) from that station.
      type = order.currentStationId === event.stationId ? "REPLACEMENT_PENDING" : "FORWARD";
      if (type === "FORWARD") fromStation = event.station;
    }

    const openVisit = openVisitByOrder.get(order.id);
    const since = order.isCheckedIn && openVisit?.receivedAt ? openVisit.receivedAt : (event?.createdAt ?? order.createdAt);

    // Only meaningful while physically checked in here — there's no current StationVisit to
    // scope the checklist to otherwise, so null rather than a stale/empty array.
    const itemProgress =
      order.isCheckedIn && openVisit
        ? order.items.map((item) => ({
            orderItemId: item.id,
            itemNo: item.itemNo,
            isFinished: progressByKey.get(`${openVisit.id}:${item.id}`) ?? false,
          }))
        : null;

    return {
      order: toOrderDto(order),
      isCheckedIn: order.isCheckedIn,
      itemProgress,
      arrival: { type, fromStation, reason, rejectionReason, defectiveItems, since },
    };
  });

  const counts = {
    pending: items.filter((i) => !i.isCheckedIn && i.arrival.type !== "REWORK" && i.arrival.type !== "QC_REROUTE").length,
    inProgress: items.filter((i) => i.isCheckedIn).length,
    rework: items.filter((i) => !i.isCheckedIn && i.arrival.type === "REWORK").length,
    qcFlag: items.filter((i) => !i.isCheckedIn && i.arrival.type === "QC_REROUTE").length,
  };

  return {
    station: { id: station.id, name: station.name, slug: station.slug },
    counts,
    items,
  };
}

export interface StationThroughputFilter {
  from?: Date;
  to?: Date;
}

interface ThroughputRow {
  stationId: string;
  totalVisits: number;
  completedVisits: number;
  reworkVisits: number;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
}

/** Aggregate dwell-time and volume metrics per station across all orders in range, filtered
 * on when each visit was received — the "which station is the actual bottleneck" view,
 * as opposed to GET /orders/:id/report's per-order turnaround. Uses raw SQL for the same
 * reason getSalesReport does: PERCENTILE_CONT (median) has no Prisma groupBy equivalent,
 * and durationMs isn't a stored column, just outgoingAt - receivedAt computed on the fly. */
export async function getStationThroughputReport(prisma: PrismaClient, filter: StationThroughputFilter) {
  const conditions: Prisma.Sql[] = [Prisma.sql`sv."receivedAt" IS NOT NULL`];
  if (filter.from) conditions.push(Prisma.sql`sv."receivedAt" >= ${filter.from}`);
  if (filter.to) conditions.push(Prisma.sql`sv."receivedAt" <= ${filter.to}`);
  const whereClause = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;

  const rows = await prisma.$queryRaw<ThroughputRow[]>(Prisma.sql`
    SELECT
      sv."stationId" AS "stationId",
      COUNT(*)::int AS "totalVisits",
      COUNT(*) FILTER (WHERE sv."outgoingAt" IS NOT NULL)::int AS "completedVisits",
      COUNT(*) FILTER (WHERE sv."isReworkVisit" = true)::int AS "reworkVisits",
      AVG(EXTRACT(EPOCH FROM (sv."outgoingAt" - sv."receivedAt")) * 1000)
        FILTER (WHERE sv."outgoingAt" IS NOT NULL)::float AS "avgDurationMs",
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (sv."outgoingAt" - sv."receivedAt")) * 1000)
        FILTER (WHERE sv."outgoingAt" IS NOT NULL)::float AS "medianDurationMs"
    FROM "station_visits" sv
    ${whereClause}
    GROUP BY sv."stationId"
  `);

  const stationIds = rows.map((r) => r.stationId);
  const stations = await prisma.station.findMany({ where: { id: { in: stationIds } } });
  const stationById = new Map(stations.map((s) => [s.id, s]));

  const byStation = rows
    .map((r) => {
      const totalVisits = Number(r.totalVisits);
      const completedVisits = Number(r.completedVisits);
      const reworkVisits = Number(r.reworkVisits);
      return {
        station: idNameSlugSummary(stationById.get(r.stationId))!,
        totalVisits,
        completedVisits,
        openVisits: totalVisits - completedVisits,
        reworkVisits,
        reworkRatePercent: totalVisits > 0 ? (reworkVisits / totalVisits) * 100 : 0,
        avgDurationMs: r.avgDurationMs !== null ? Math.round(r.avgDurationMs) : null,
        medianDurationMs: r.medianDurationMs !== null ? Math.round(r.medianDurationMs) : null,
      };
    })
    // Slowest average dwell time first — the likely bottleneck. Stations with no completed
    // visit yet (avgDurationMs null) sort last rather than colliding with a real 0ms average.
    .sort((a, b) => (b.avgDurationMs ?? -1) - (a.avgDurationMs ?? -1));

  const totalVisits = byStation.reduce((sum, s) => sum + s.totalVisits, 0);
  const totalCompletedVisits = byStation.reduce((sum, s) => sum + s.completedVisits, 0);
  const totalReworkVisits = byStation.reduce((sum, s) => sum + s.reworkVisits, 0);

  return {
    from: filter.from ?? null,
    to: filter.to ?? null,
    totalVisits,
    totalCompletedVisits,
    totalReworkVisits,
    overallReworkRatePercent: totalVisits > 0 ? (totalReworkVisits / totalVisits) * 100 : 0,
    byStation,
  };
}

export interface EmployeeTasksFilter {
  category?: "IN_PROGRESS" | "REWORK" | "QC_FLAG" | "COMPLETED";
  page: number;
  pageSize: number;
}

/**
 * One employee's task history across every station they've ever worked at — not just their
 * current assignedStationId — one row per StationVisit they personally received. Categorized
 * the same way a station's live queue is (see getStationQueue above): a visit tied to a
 * ReworkRoute with a qcReviewId is QC_FLAG (a formal QC decision sent it back here), tied to
 * a route without one is REWORK (a peer station's own rejection), otherwise it's an ordinary
 * task — IN_PROGRESS while still checked in (no outgoingAt yet) or COMPLETED once sent onward.
 * Employee task histories are bounded (one person's working lifetime), so this batches a
 * handful of queries and paginates in JS rather than reaching for raw SQL.
 */
export async function getEmployeeTasks(prisma: PrismaClient, userId: string, filter: EmployeeTasksFilter) {
  const employee = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: { select: { name: true } } },
  });
  if (!employee) throw new NotFoundError("User not found");

  const visits = await prisma.stationVisit.findMany({
    where: { receivedByUserId: userId },
    orderBy: { receivedAt: "desc" },
  });

  const routeIds = [...new Set(visits.map((v) => v.reworkRouteId).filter((id): id is string => !!id))];
  const routes = routeIds.length
    ? await prisma.reworkRoute.findMany({
        where: { id: { in: routeIds } },
        include: {
          fromStation: { select: { id: true, name: true, slug: true } },
          rejectionReason: { select: { id: true, name: true, slug: true } },
        },
      })
    : [];
  const routeById = new Map(routes.map((r) => [r.id, r]));

  const orderIds = [...new Set(visits.map((v) => v.orderId))];
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      isArchived: true,
      customer: { select: { name: true } },
    },
  });
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const stationIds = [...new Set(visits.map((v) => v.stationId))];
  const stations = await prisma.station.findMany({ where: { id: { in: stationIds } } });
  const stationById = new Map(stations.map((s) => [s.id, s]));

  const categorized = visits.map((visit) => {
    const route = visit.reworkRouteId ? routeById.get(visit.reworkRouteId) : undefined;
    const category: NonNullable<EmployeeTasksFilter["category"]> = route
      ? route.qcReviewId
        ? "QC_FLAG"
        : "REWORK"
      : visit.outgoingAt
        ? "COMPLETED"
        : "IN_PROGRESS";

    const station = stationById.get(visit.stationId)!;
    const order = orderById.get(visit.orderId)!;

    return {
      id: visit.id,
      category,
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        customerName: order.customer.name,
        status: order.status,
        isArchived: order.isArchived,
      },
      station: idNameSlugSummary(station)!,
      sequenceNo: visit.sequenceNo,
      receivedAt: visit.receivedAt,
      outgoingAt: visit.outgoingAt,
      rework: route
        ? {
            fromStation: idNameSlugSummary(route.fromStation),
            reason: route.reason,
            rejectionReason: idNameSlugSummary(route.rejectionReason),
          }
        : null,
    };
  });

  const counts = {
    inProgress: categorized.filter((t) => t.category === "IN_PROGRESS").length,
    rework: categorized.filter((t) => t.category === "REWORK").length,
    qcFlag: categorized.filter((t) => t.category === "QC_FLAG").length,
    completed: categorized.filter((t) => t.category === "COMPLETED").length,
  };

  const filtered = filter.category ? categorized.filter((t) => t.category === filter.category) : categorized;
  const total = filtered.length;
  const start = (filter.page - 1) * filter.pageSize;
  const items = filtered.slice(start, start + filter.pageSize);

  return {
    employee: { id: employee.id, name: employee.name, roleName: employee.role.name },
    counts,
    items,
    page: filter.page,
    pageSize: filter.pageSize,
    total,
  };
}

export function listStations(prisma: PrismaClient, includeInactive?: boolean) {
  // isSystem asc puts dynamic stations first, system stages (QC, Packaging, Courier/Pick-up) last —
  // mirrors workflow.ts's activeSorted() so this list always reflects the real production
  // sequence regardless of what raw sortOrder value a system station happens to carry.
  return prisma.station.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ isSystem: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
}

export interface CreateStationInput {
  name: string;
  slug?: string;
  logoUrl?: string;
  description?: string;
  colorHex?: string;
  sortOrder?: number;
  isQcCheckpoint?: boolean;
}

export async function createStation(prisma: PrismaClient, actorUserId: string, input: CreateStationInput) {
  const slug = input.slug ?? slugify(input.name);

  const existing = await prisma.station.findFirst({ where: { OR: [{ name: input.name }, { slug }] } });
  if (existing) {
    throw new ValidationError("A station with this name or slug already exists");
  }
  // QC is a fixed system stage now, seeded once — a dynamic station declaring itself a
  // checkpoint would recreate a second, arbitrary QC gate, which defeats the point.
  if (input.isQcCheckpoint) {
    throw new ValidationError("Only the fixed QC system stage can be a QC checkpoint — dynamic stations cannot.");
  }

  return prisma.$transaction(async (tx) => {
    const station = await tx.station.create({
      data: {
        name: input.name,
        slug,
        logoUrl: input.logoUrl,
        description: input.description,
        colorHex: input.colorHex,
        sortOrder: input.sortOrder ?? 0,
        isQcCheckpoint: input.isQcCheckpoint ?? false,
      },
    });

    await recordActivity(tx, {
      action: "CREATED",
      entityType: "STATION",
      entityId: station.id,
      actorUserId,
      message: `Station ${station.name} created.`,
    });

    return station;
  });
}

export interface UpdateStationInput {
  name?: string;
  slug?: string;
  logoUrl?: string | null;
  description?: string | null;
  colorHex?: string | null;
  sortOrder?: number;
  isQcCheckpoint?: boolean;
  isActive?: boolean;
}

export async function updateStation(prisma: PrismaClient, id: string, actorUserId: string, input: UpdateStationInput) {
  const existing = await prisma.station.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Station not found");

  if (existing.isSystem) {
    throw new ConflictError(
      `${existing.name} is a fixed system stage and cannot be edited — it always runs after every dynamic station.`,
    );
  }
  if (input.isQcCheckpoint) {
    throw new ValidationError("Only the fixed QC system stage can be a QC checkpoint — dynamic stations cannot.");
  }

  if (input.name || input.slug) {
    const conflict = await prisma.station.findFirst({
      where: {
        id: { not: id },
        OR: [input.name ? { name: input.name } : undefined, input.slug ? { slug: input.slug } : undefined].filter(
          Boolean,
        ) as object[],
      },
    });
    if (conflict) throw new ValidationError("A station with this name or slug already exists");
  }

  // Reordering the production sequence while orders are mid-flight can silently change
  // an in-progress order's remaining path (skip a station, or shift what counts as
  // "last") — see workflow.ts, nextStationAfter/lastStation are always computed live,
  // never fixed per order. Safer to require the line be clear first.
  if (input.sortOrder !== undefined && input.sortOrder !== existing.sortOrder) {
    const inFlightCount = await prisma.order.count({ where: { status: OrderStatus.IN_PROGRESS } });
    if (inFlightCount > 0) {
      throw new ConflictError(
        `Cannot reorder stations while ${inFlightCount} order(s) are still in progress. Wait until they're all delivered, or reorder when the line is clear.`,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const station = await tx.station.update({
      where: { id },
      data: {
        name: input.name,
        slug: input.slug,
        logoUrl: input.logoUrl,
        description: input.description,
        colorHex: input.colorHex,
        sortOrder: input.sortOrder,
        isQcCheckpoint: input.isQcCheckpoint,
        isActive: input.isActive,
      },
    });

    await recordActivity(tx, {
      action: "UPDATED",
      entityType: "STATION",
      entityId: station.id,
      actorUserId,
      message: `Station ${station.name} updated.`,
    });

    return station;
  });
}
