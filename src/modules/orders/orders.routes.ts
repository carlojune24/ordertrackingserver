import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  intakeBodySchema,
  listOrdersQuerySchema,
  orderIdParamsSchema,
  orderItemBodySchema,
  orderItemIdParamsSchema,
  orderListResponseSchema,
  orderResponseSchema,
  overrideStationBodySchema,
  updateOrderBodySchema,
  updateOrderItemBodySchema,
} from "./orders.schemas";
import {
  addOrderItem,
  archiveOrder,
  createOrder,
  getOrderOrThrow,
  listOrders,
  overrideStation,
  removeOrderItem,
  toOrderDto,
  unarchiveOrder,
  updateOrder,
  updateOrderItem,
} from "./orders.service";
import { renderOrderQrPng, regenerateOrderQr } from "../qr/qr.service";

export default async function ordersRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const ordersCreate = fastify.authorize("orders.create");
  const ordersEdit = fastify.authorize("orders.edit");
  const ordersArchive = fastify.authorize("orders.archive");
  const qrRegenerate = fastify.authorize("orders.qr.regenerate");
  const ordersOverrideStation = fastify.authorize("orders.override_station");

  app.post(
    "/",
    {
      preHandler: [fastify.authenticate, ordersCreate],
      schema: {
        tags: ["Orders"],
        summary: "Order intake",
        description: "Generates the order number and QR token, creates one OrderItem per entry in `items` (min 1) snapshotting each product's current price (`unitPrice`/`regularPriceAtOrder` — see field docs), and routes the order to the active station with the lowest `sortOrder`. The order itself is one shared physical unit through production regardless of how many items it has — see the item endpoints below to add/edit/remove items after intake.",
        security: [{ bearerAuth: [] }],
        body: intakeBodySchema,
        response: { 201: orderResponseSchema },
      },
    },
    async (request, reply) => {
      const order = await createOrder(fastify.prisma, request.user.sub, request.body);
      reply.code(201);
      return toOrderDto(order);
    },
  );

  app.get(
    "/",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Orders"],
        summary: "Dashboard listing",
        description: "Sorted priority ascending (unflagged orders last via NULLS LAST), then by deadline. This is the primary feed for a production dashboard — combine `status`, `stationId`, `overdue`, and `categoryId` filters to build per-station or per-brand views.",
        security: [{ bearerAuth: [] }],
        querystring: listOrdersQuerySchema,
        response: { 200: orderListResponseSchema },
      },
    },
    async (request) => {
      const { page, pageSize, ...rest } = request.query;
      const { items, total } = await listOrders(fastify.prisma, { page, pageSize, ...rest });
      return { items: items.map(toOrderDto), page, pageSize, total };
    },
  );

  app.get(
    "/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Orders"],
        summary: "Get an order",
        description: "Full order state — current station, checked-in status, its item lines (each with product/color-lining and pricing), and order-level pricing aggregates (subtotal/totalDiscount/finalPrice). For the event-by-event history use /timeline; for per-station durations use /report.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => toOrderDto(await getOrderOrThrow(fastify.prisma, request.params.id)),
  );

  app.patch(
    "/:id",
    {
      preHandler: [fastify.authenticate, ordersEdit],
      schema: {
        tags: ["Orders"],
        summary: "Edit an order",
        description: "Partial update of order-level fields only (customer, duration, priority, down payment) — item/pricing edits (product, color lining, quantity, discount) go through the item endpoints below. Changing `proposedDurationDays` recomputes `deadline` from the original `orderDate`, not from now.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        body: updateOrderBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => toOrderDto(await updateOrder(fastify.prisma, request.params.id, request.user.sub, request.body)),
  );

  app.post(
    "/:id/items",
    {
      preHandler: [fastify.authenticate, ordersEdit],
      schema: {
        tags: ["Orders"],
        summary: "Add an item to an order",
        description: "Adds one more OrderItem line to an existing, non-archived order — same product/color-lining/discount validation as intake. Writes an ITEM_ADDED event to the order's timeline.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        body: orderItemBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => toOrderDto(await addOrderItem(fastify.prisma, request.params.id, request.user.sub, request.body)),
  );

  app.patch(
    "/:id/items/:itemId",
    {
      preHandler: [fastify.authenticate, ordersEdit],
      schema: {
        tags: ["Orders"],
        summary: "Edit one item on an order",
        description: "Partial update of a single OrderItem — product, color lining, quantity, discount. Changing `productId` re-snapshots `unitPrice`/`regularPriceAtOrder` from the new product's current price, same rule as order-level edits used to follow. Writes an ITEM_UPDATED event.",
        security: [{ bearerAuth: [] }],
        params: orderItemIdParamsSchema,
        body: updateOrderItemBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) =>
      toOrderDto(await updateOrderItem(fastify.prisma, request.params.id, request.params.itemId, request.user.sub, request.body)),
  );

  app.delete(
    "/:id/items/:itemId",
    {
      preHandler: [fastify.authenticate, ordersEdit],
      schema: {
        tags: ["Orders"],
        summary: "Remove an item from an order",
        description: "Removes a single OrderItem line. Blocked with 409 if it's the order's last remaining item — an order must always have at least one. Writes an ITEM_REMOVED event.",
        security: [{ bearerAuth: [] }],
        params: orderItemIdParamsSchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => toOrderDto(await removeOrderItem(fastify.prisma, request.params.id, request.params.itemId, request.user.sub)),
  );

  app.post(
    "/:id/archive",
    {
      preHandler: [fastify.authenticate, ordersArchive],
      schema: {
        tags: ["Orders"],
        summary: "Archive an order",
        description: "Fully freezes the order — further edits, scans, QC decisions, and delivery outcomes are all rejected with 409 until it's unarchived — and hides it from GET /orders by default (pass includeArchived=true to see it there, or fetch it directly by id). Any order can be archived regardless of status. Idempotent — archiving an already-archived order is a no-op.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => toOrderDto(await archiveOrder(fastify.prisma, request.params.id, request.user.sub)),
  );

  app.post(
    "/:id/unarchive",
    {
      preHandler: [fastify.authenticate, ordersArchive],
      schema: {
        tags: ["Orders"],
        summary: "Unarchive an order",
        description: "Reverses archive — the order becomes editable/actionable again and reappears in the default GET /orders listing. Idempotent — unarchiving an already-active order is a no-op.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => toOrderDto(await unarchiveOrder(fastify.prisma, request.params.id, request.user.sub)),
  );

  app.post(
    "/:id/override-station",
    {
      preHandler: [fastify.authenticate, ordersOverrideStation],
      schema: {
        tags: ["Orders"],
        summary: "Admin override: station + worker assignment",
        description: "Management-only escape hatch that repoints an order at any active station — including the fixed QC/Packaging/Courier system stages, unlike every other transition in this app — bypassing the normal scan/QC/delivery workflow entirely. Marks the order as physically checked in there (closes any open StationVisit, opens a new one) and can pin it to one specific worker (must already be assigned to that station via `assignedStationId`, 400 otherwise). The worker pin is never carried over from a previous override — omit or pass null to leave it unpinned. Always writes a `STATION_OVERRIDDEN` event to the order's timeline for accountability.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        body: overrideStationBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => toOrderDto(await overrideStation(fastify.prisma, request.params.id, request.user.sub, request.body)),
  );

  app.get(
    "/:id/qr",
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ["Orders"],
        summary: "QR image (PNG)",
        description: "Returns `image/png` binary, not JSON — encodes the order's `qrToken` for printing on the job ticket. Point an `<img>` tag at this URL (with the auth header attached, e.g. via a blob fetch).",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
      },
    },
    async (request, reply) => {
      const order = await getOrderOrThrow(fastify.prisma, request.params.id);
      const png = await renderOrderQrPng(order.qrToken);
      reply.header("Content-Type", "image/png");
      return reply.send(png);
    },
  );

  app.post(
    "/:id/qr/regenerate",
    {
      preHandler: [fastify.authenticate, qrRegenerate],
      schema: {
        tags: ["Orders"],
        summary: "Regenerate QR token",
        description: "Rotates `qrToken` to a new value — use when a physical tag is lost or damaged. The old QR code stops working immediately. `orderNumber` and everything else about the order is untouched.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => toOrderDto(await regenerateOrderQr(fastify.prisma, request.params.id, request.user.sub)),
  );
}
