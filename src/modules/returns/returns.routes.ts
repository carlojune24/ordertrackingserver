import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  addReturnReviewImageBodySchema,
  issueReplacementBodySchema,
  returnDecisionBodySchema,
  returnReviewImageIdParamsSchema,
  returnReviewImageParamsSchema,
  returnReviewResponseSchema,
} from "./returns.schemas";
import {
  addReturnReviewImage,
  issueReplacement,
  removeReturnReviewImage,
  submitReturnDecision,
  uploadReturnReviewImage,
} from "./returns.service";
import { returnsReportQuerySchema, returnsReportResponseSchema } from "./returnsReport.schemas";
import { getReturnsReport } from "./returnsReport.service";
import { orderIdParamsSchema, orderResponseSchema } from "../orders/orders.schemas";
import { toOrderDto } from "../orders/orders.service";
import { ValidationError } from "../../lib/errors";

export default async function returnsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const returnDecide = fastify.authorize("return.decide");
  const replacementIssue = fastify.authorize("orders.replacement.issue");
  const reportView = fastify.authorize("orders.report.view");

  app.get(
    "/reports/returns",
    {
      preHandler: [fastify.authenticate, reportView],
      schema: {
        tags: ["Returns"],
        summary: "Returned products report",
        description: "What came back, why, from which customer, and who handled it at delivery: one row per RETURNED delivery outcome, newest first, filtered by date range (when the return was recorded), reason, product category (car brand) and a search over order number / customer / product. `summary`, `byReason`, `byCategory` and `topProducts` cover the whole filtered set, not just the current page. Each row's `status` follows the order after the return (on the way back, at Return, sent to QC, for replacement, replacement issued). Archived orders are excluded. Same access tier as the sales/QC reports (orders.report.view).",
        security: [{ bearerAuth: [] }],
        querystring: returnsReportQuerySchema,
        response: { 200: returnsReportResponseSchema },
      },
    },
    async (request) => getReturnsReport(fastify.prisma, request.query),
  );

  app.post(
    "/:id/return-decision",
    {
      preHandler: [fastify.authenticate, returnDecide],
      schema: {
        tags: ["Returns"],
        summary: "Submit a Return station decision",
        description: "Only legal when the order is checked in at the fixed Return station (409 otherwise) — orders get there when delivery records RETURNED, then are received there with a normal scan. SEND_TO_QC moves the order to QC (not checked in); QC then receives it and approves or routes rework exactly as usual. FOR_REPLACEMENT requires `orderItemIds` and flags those items (`replacementStatus: FLAGGED`), leaving the order parked at Return until a Supervisor+ calls POST /orders/:id/issue-replacement. A plain outgoing scan at Return is rejected — this is its only exit.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        body: returnDecisionBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => toOrderDto(await submitReturnDecision(fastify.prisma, request.params.id, request.user.sub, request.body)),
  );

  app.post(
    "/:id/issue-replacement",
    {
      preHandler: [fastify.authenticate, replacementIssue],
      schema: {
        tags: ["Returns"],
        summary: "Issue a replacement",
        description: "For an order parked at Return with items flagged FOR_REPLACEMENT. Marks those items ISSUED and loops the SAME order (same order number, QR and timeline — no new order) back to the first production station, to run the normal station flow again; its new visits are flagged as revisits. 409 if the order is not parked at Return or nothing is flagged.",
        security: [{ bearerAuth: [] }],
        params: orderIdParamsSchema,
        body: issueReplacementBodySchema,
        response: { 200: orderResponseSchema },
      },
    },
    async (request) => toOrderDto(await issueReplacement(fastify.prisma, request.params.id, request.user.sub, request.body.notes)),
  );

  app.post(
    "/:id/return-reviews/:reviewId/images",
    {
      preHandler: [fastify.authenticate, returnDecide],
      schema: {
        tags: ["Returns"],
        summary: "Attach a return review image",
        description: "`url` must point to an already-hosted image — there's no file upload endpoint here, so host it elsewhere first and pass the link. For record purposes: photo evidence of the returned item's condition, attached to a specific Return station decision (`reviewId`).",
        security: [{ bearerAuth: [] }],
        params: returnReviewImageParamsSchema,
        body: addReturnReviewImageBodySchema,
        response: { 201: returnReviewResponseSchema },
      },
    },
    async (request, reply) => {
      const review = await addReturnReviewImage(fastify.prisma, request.params.id, request.params.reviewId, request.body.url);
      reply.code(201);
      return review;
    },
  );

  app.post(
    "/:id/return-reviews/:reviewId/images/upload",
    {
      preHandler: [fastify.authenticate, returnDecide],
      schema: {
        tags: ["Returns"],
        summary: "Upload a return review image",
        description: "Multipart file upload (field name `file`) — stored locally on the server under /uploads/returns and served back as a public URL, no third-party storage involved. Accepts JPEG, PNG, GIF, or WebP, validated by the file's actual content rather than its extension, up to 5MB. Prefer this over POST /:id/return-reviews/:reviewId/images when you don't already have the photo hosted somewhere.",
        security: [{ bearerAuth: [] }],
        params: returnReviewImageParamsSchema,
        consumes: ["multipart/form-data"],
        response: { 201: returnReviewResponseSchema },
      },
    },
    async (request, reply) => {
      const file = await request.file().catch(() => undefined);
      if (!file) {
        throw new ValidationError('No file uploaded — send multipart/form-data with a field named "file".');
      }
      const buffer = await file.toBuffer();
      const review = await uploadReturnReviewImage(fastify.prisma, request.params.id, request.params.reviewId, buffer);
      reply.code(201);
      return review;
    },
  );

  app.delete(
    "/:id/return-reviews/:reviewId/images/:imageId",
    {
      preHandler: [fastify.authenticate, returnDecide],
      schema: {
        tags: ["Returns"],
        summary: "Remove a return review image",
        description: "A real (hard) delete — safe here since nothing else references a specific image.",
        security: [{ bearerAuth: [] }],
        params: returnReviewImageIdParamsSchema,
        response: { 200: returnReviewResponseSchema },
      },
    },
    async (request) => removeReturnReviewImage(fastify.prisma, request.params.id, request.params.reviewId, request.params.imageId),
  );
}
