import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { itemProgressBodySchema, itemProgressResponseSchema, rejectBodySchema, scanBodySchema } from "./scan.schemas";
import { logOutgoingAtStation, receiveAtStation, returnForRework, setItemStationProgress } from "./scan.service";
import { orderResponseSchema } from "../orders/orders.schemas";
import { toOrderDto } from "../orders/orders.service";

export default async function scanRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const staffPlus = fastify.authorize("scan.perform");

  app.post(
    "/receive",
    {
      preHandler: [fastify.authenticate, staffPlus],
      schema: {
        tags: ["Scanning"],
        summary: "Receive at station",
        description: "Checks an order in at `stationId`. Legal only when the order is in transit toward exactly this station (`isCheckedIn: false` and `currentStationId` matches) — anything else 409s with a message naming what actually is expected. Creates a new StationVisit row (its `sequenceNo` and `isReworkVisit` are derived automatically from how many visits this order already has at this station). If the caller has an `assignedStationId` (a station worker), scanning at any other station 403s.",
        security: [{ bearerAuth: [] }],
        body: scanBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => {
      const { qrToken, stationId } = request.body;
      const order = await receiveAtStation(fastify.prisma, qrToken, stationId, request.user.sub);
      return toOrderDto(order);
    },
  );

  app.post(
    "/outgoing",
    {
      preHandler: [fastify.authenticate, staffPlus],
      schema: {
        tags: ["Scanning"],
        summary: "Log outgoing at station",
        description: "Checks an order out of the station it's currently checked in at, and advances `currentStationId`. Normally this is whichever active station is next in the production sequence — dynamic stations first by `sortOrder`, then the fixed QC, Packaging, and Courier/Pick-up system stages last, in that order (or leaves it at the current station, awaiting a delivery outcome, if this was the last one). Exception: if this visit is the resulting revisit of a formal QC rework (POST /orders/:id/qc-decision, not a plain peer-station rejection via POST /scan/reject), it routes straight back to QC instead of continuing the normal sequence — only this station's work was flagged, so there's nothing for the stations in between to redo. QC-checkpoint stations (`isQcCheckpoint: true`) have no plain outgoing scan — this always 409s there; use POST /orders/:id/qc-decision instead. If the caller has an `assignedStationId` (a station worker), scanning at any other station 403s.",
        security: [{ bearerAuth: [] }],
        body: scanBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => {
      const { qrToken, stationId } = request.body;
      const order = await logOutgoingAtStation(fastify.prisma, qrToken, stationId, request.user.sub);
      return toOrderDto(order);
    },
  );

  app.post(
    "/reject",
    {
      preHandler: [fastify.authenticate, staffPlus],
      schema: {
        tags: ["Scanning"],
        summary: "Reject for rework at station",
        description: "Instead of logging a normal outgoing scan, the station currently holding the order sends it back exactly one step — to whichever active station immediately precedes it — for rework. Only legal at a regular (non-system) station that's currently checked in (409 otherwise); QC and Courier/Pick-up use their own decision flows instead (POST /orders/:id/qc-decision, POST /orders/:id/delivery-outcome), and Packaging has no rework/rejection path at all — it can only log a normal outgoing scan forward into delivery. 409s if this is the first station (nothing earlier to return to). Optional rejectionReasonId/reason are the same categorization used by qc-decision's REWORK path — both feed GET /orders/reports/qc. If the caller has an assignedStationId (a station worker), rejecting at any other station 403s.",
        security: [{ bearerAuth: [] }],
        body: rejectBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => {
      const { qrToken, stationId, rejectionReasonId, reason, orderItemIds } = request.body;
      const order = await returnForRework(fastify.prisma, qrToken, stationId, request.user.sub, { rejectionReasonId, reason, orderItemIds });
      return toOrderDto(order);
    },
  );

  app.post(
    "/item-progress",
    {
      preHandler: [fastify.authenticate, staffPlus],
      schema: {
        tags: ["Scanning"],
        summary: "Toggle an item's finished checklist at a station",
        description: "Marks one item on the order as finished (or not) at the station it's currently checked in at — a per-item checklist, purely informational. Does not gate POST /scan/outgoing; the order still advances as one physical unit regardless of this flag. Scoped to the order's current StationVisit at this station, so a rework revisit starts every item back at not-finished automatically. 409s if the order isn't currently checked in at stationId. If the caller has an assignedStationId (a station worker), toggling at any other station 403s.",
        security: [{ bearerAuth: [] }],
        body: itemProgressBodySchema,
        response: { 200: itemProgressResponseSchema },
      },
    },
    async (request) => {
      const { qrToken, stationId, orderItemId, isFinished } = request.body;
      return setItemStationProgress(fastify.prisma, qrToken, stationId, request.user.sub, { orderItemId, isFinished });
    },
  );
}
