import { z } from "zod";
import { OrderStatus } from "../../generated/prisma/enums";
import { listOrdersQuerySchema, orderResponseSchema } from "../orders/orders.schemas";

const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "colorHex must be a 6-digit hex color, e.g. #FF8800");

export const createStationBodySchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens only").optional(),
  logoUrl: z.string().url().optional().describe("Must already be hosted somewhere — there's no upload endpoint."),
  description: z.string().min(1).optional(),
  colorHex: hexColorSchema.optional().describe("For dashboard chips/badges — station names aren't a known fixed set the frontend can hardcode colors for anymore."),
  sortOrder: z.number().int().optional().describe("Position in the production sequence — lower runs first. No uniqueness constraint; ties fall back to alphabetical by name."),
  isQcCheckpoint: z.boolean().optional().describe("Always false for dynamic stations — only the fixed QC system stage can be a checkpoint. Sending true here 400s."),
});

export const updateStationBodySchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens only").optional(),
  logoUrl: z.string().url().nullable().optional(),
  description: z.string().min(1).nullable().optional(),
  colorHex: hexColorSchema.nullable().optional(),
  sortOrder: z.number().int().optional().describe("An actual change is rejected with 409 while any order is IN_PROGRESS — see the route description."),
  isQcCheckpoint: z.boolean().optional().describe("Always false for dynamic stations — only the fixed QC system stage can be a checkpoint. Sending true here 400s."),
  isActive: z.boolean().optional().describe("Set to false to retire the station — historical StationVisit/OrderEvent rows referencing it are unaffected."),
});

export const listStationsQuerySchema = z.object({
  includeInactive: z.coerce.boolean().optional(),
});

export const stationIdParamsSchema = z.object({ id: z.string() });

export const stationResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logoUrl: z.string().nullable(),
  description: z.string().nullable(),
  colorHex: z.string().nullable(),
  sortOrder: z.number(),
  isQcCheckpoint: z.boolean(),
  isSystem: z.boolean().describe("Fixed system stage (QC, Packaging, Courier/Pick-up, Return) — cannot be edited via PATCH and always sorts after every dynamic station."),
  isReturnStation: z.boolean().describe("The fixed Return section. Sits off the production sequence: entered when delivery records RETURNED, left only via POST /orders/:id/return-decision."),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const stationListResponseSchema = z.array(stationResponseSchema);

export const stationCurrentOrdersQuerySchema = listOrdersQuerySchema.pick({ page: true, pageSize: true });

const queueStationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

const queueRejectionReasonSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

const queueColorLiningSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
});

const queueDefectiveItemSchema = z.object({
  id: z.string(),
  itemNo: z.number().int().describe("Position within the order — \"item 2\", not the internal id."),
  product: z.object({ id: z.string(), name: z.string() }),
  colorLining: queueColorLiningSummarySchema.nullable(),
  quantity: z.number().int(),
});

export const queueArrivalTypeSchema = z.enum(["NEW", "FORWARD", "REWORK", "QC_REROUTE", "RETURNED", "OVERRIDE", "REPLACEMENT", "REPLACEMENT_PENDING"]);

const queueItemProgressSchema = z.object({
  orderItemId: z.string(),
  itemNo: z.number().int().describe("Position within the order — \"item 2\", not the internal id."),
  isFinished: z.boolean().describe("Purely informational checklist state, set via POST /scan/item-progress — does not gate POST /scan/outgoing. Defaults to false until someone toggles it."),
});

const queueItemSchema = z.object({
  order: orderResponseSchema,
  isCheckedIn: z.boolean(),
  itemProgress: z
    .array(queueItemProgressSchema)
    .nullable()
    .describe("One entry per item on the order, only while isCheckedIn is true (there's no current station visit to scope the checklist to otherwise, hence null rather than an empty array)."),
  arrival: z.object({
    type: queueArrivalTypeSchema.describe("NEW = fresh from intake. FORWARD = normal hand-off from the previous station. REWORK = a regular station rejected it via POST /scan/reject. QC_REROUTE = QC sent it back via qc-decision. RETURNED = a customer return re-entered the workflow here. OVERRIDE = an admin repointed it here via POST /orders/:id/override-station, bypassing the normal workflow. REPLACEMENT = a Supervisor+ issued a replacement and looped it back to the first station. REPLACEMENT_PENDING = at Return, flagged for replacement and waiting to be issued."),
    fromStation: queueStationSummarySchema.nullable().describe("Which station it came from — set for FORWARD (the station it left), REWORK, and QC_REROUTE (the rejecting station); null for NEW, RETURNED, and OVERRIDE."),
    reason: z.string().nullable().describe("Free-text rejection detail — only set for REWORK/QC_REROUTE."),
    rejectionReason: queueRejectionReasonSummarySchema.nullable().describe("Structured rejection category, if one was given — only set for REWORK/QC_REROUTE."),
    defectiveItems: z.array(queueDefectiveItemSchema).describe("Which specific item(s) on the order were flagged as defective, if the rework named any — only ever non-empty for REWORK/QC_REROUTE."),
    since: z.date().describe("When this state began: the open StationVisit's receivedAt if isCheckedIn is true, otherwise the timestamp of the event that routed it here (intake, outgoing scan, or rework routing)."),
  }),
});

export const stationThroughputReportQuerySchema = z.object({
  from: z.coerce.date().optional().describe("Inclusive lower bound on when the visit was received (StationVisit.receivedAt). Omit for no lower bound."),
  to: z.coerce.date().optional().describe("Inclusive upper bound on when the visit was received. Omit for no upper bound."),
});

const stationThroughputBreakdownSchema = z.object({
  station: queueStationSummarySchema,
  totalVisits: z.number().describe("Every StationVisit received at this station in range, whether or not it has finished yet."),
  completedVisits: z.number().describe("Visits with both receivedAt and outgoingAt set — the ones duration is computed from."),
  openVisits: z.number().describe("totalVisits - completedVisits — still checked in here, no outgoing logged yet."),
  reworkVisits: z.number().describe("Visits where isReworkVisit is true — a rework or return revisit, not the order's first time at this station."),
  reworkRatePercent: z.number().describe("reworkVisits / totalVisits * 100, 0 if totalVisits is 0."),
  avgDurationMs: z.number().nullable().describe("Average outgoingAt - receivedAt across completedVisits, in milliseconds. Null if no visit at this station has completed yet."),
  medianDurationMs: z.number().nullable().describe("Median duration across completedVisits — less skewed by one unusually slow outlier visit than the average, so it better reflects the typical case. Null if no visit has completed yet."),
});

export const stationThroughputReportResponseSchema = z.object({
  from: z.date().nullable(),
  to: z.date().nullable(),
  totalVisits: z.number(),
  totalCompletedVisits: z.number(),
  totalReworkVisits: z.number(),
  overallReworkRatePercent: z.number(),
  byStation: z
    .array(stationThroughputBreakdownSchema)
    .describe("Sorted by avgDurationMs descending — the slowest, most likely bottleneck station first. A station with zero visits in range simply doesn't appear."),
});

export const stationQueueResponseSchema = z.object({
  station: queueStationSummarySchema,
  counts: z.object({
    pending: z.number().describe("Not yet checked in, and not a rework/QC-flagged arrival."),
    inProgress: z.number().describe("Currently checked in (isCheckedIn: true), regardless of how it arrived."),
    rework: z.number().describe("Not yet checked in, arrived via a regular station's rejection (arrival.type === REWORK)."),
    qcFlag: z.number().describe("Not yet checked in, arrived via a QC reroute (arrival.type === QC_REROUTE)."),
  }),
  items: z.array(queueItemSchema).describe("Sorted the same way as the main order dashboard (priority ascending, then deadline)."),
});

export const employeeTaskCategorySchema = z.enum(["IN_PROGRESS", "REWORK", "QC_FLAG", "COMPLETED"]);

export const employeeTasksQuerySchema = z.object({
  category: employeeTaskCategorySchema.optional().describe("Filter to just one bucket. Omit to get all four, newest received first."),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

const employeeTaskOrderSummarySchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  customerName: z.string(),
  status: z.enum(OrderStatus),
  isArchived: z.boolean(),
});

const employeeTaskSchema = z.object({
  id: z.string().describe("The underlying StationVisit id."),
  category: employeeTaskCategorySchema.describe("REWORK/QC_FLAG take priority over IN_PROGRESS/COMPLETED — a task can be both a redo and still in progress, but it's reported as the redo. QC_FLAG = the redo was routed here by a formal QC decision; REWORK = by a regular station's own rejection. Otherwise IN_PROGRESS (no outgoingAt yet) or COMPLETED (sent onward)."),
  order: employeeTaskOrderSummarySchema,
  station: queueStationSummarySchema.describe("Which station this task was worked at — not necessarily the employee's current assignedStationId, since this covers their whole history."),
  sequenceNo: z.number().int(),
  receivedAt: z.date().nullable(),
  outgoingAt: z.date().nullable(),
  rework: z
    .object({
      fromStation: queueStationSummarySchema.nullable(),
      reason: z.string().nullable(),
      rejectionReason: queueRejectionReasonSummarySchema.nullable(),
    })
    .nullable()
    .describe("Set only for REWORK/QC_FLAG tasks — the station that rejected it and why, if given."),
});

export const employeeTasksResponseSchema = z.object({
  employee: z.object({ id: z.string(), name: z.string(), roleName: z.string() }),
  counts: z
    .object({
      inProgress: z.number(),
      rework: z.number(),
      qcFlag: z.number(),
      completed: z.number(),
    })
    .describe("Totals across the employee's whole history, unaffected by the category filter or pagination below."),
  items: z.array(employeeTaskSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number().describe("Count within the selected category (or across all four if none was given) — what page/pageSize paginate over."),
});
