import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import prismaPlugin from "./plugins/prisma";
import jwtPlugin from "./plugins/jwt";
import rbacPlugin from "./plugins/rbac";
import uploadsPlugin from "./plugins/uploads";
import { AppError } from "./lib/errors";

import healthRoutes from "./modules/health/health.routes";
import authRoutes from "./modules/auth/auth.routes";
import usersRoutes from "./modules/users/users.routes";
import rolesRoutes from "./modules/roles/roles.routes";
import permissionsRoutes from "./modules/permissions/permissions.routes";
import categoriesRoutes from "./modules/categories/categories.routes";
import customersRoutes from "./modules/customers/customers.routes";
import productsRoutes from "./modules/products/products.routes";
import promoCodesRoutes from "./modules/promoCodes/promoCodes.routes";
import stationsRoutes from "./modules/stations/stations.routes";
import qcRejectionReasonsRoutes from "./modules/qcRejectionReasons/qcRejectionReasons.routes";
import ordersRoutes from "./modules/orders/orders.routes";
import scanRoutes from "./modules/scan/scan.routes";
import qcRoutes from "./modules/qc/qc.routes";
import deliveryRoutes from "./modules/delivery/delivery.routes";
import returnsRoutes from "./modules/returns/returns.routes";
import concernsRoutes from "./modules/concerns/concerns.routes";
import timelineRoutes from "./modules/timeline/timeline.routes";
import activityRoutes from "./modules/activity/activity.routes";
import eventsRoutes from "./modules/events/events.routes";

export function buildApp() {
  const fastify = Fastify({
    // Production sits behind Nginx (see README/plan.md) — without this, request.ip would
    // always resolve to the proxy's local address instead of the real client, making the
    // activity log's ip field useless there.
    trustProxy: true,
    logger: {
      transport: process.env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
    },
  });

  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  fastify.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.status(400).send({
        error: "ValidationError",
        message: "Request validation failed",
        details: error.validation,
      });
      return;
    }

    if (error instanceof AppError) {
      reply.status(error.statusCode).send({ error: error.name, message: error.message });
      return;
    }

    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : "Something went wrong";

    // 4xx here means Fastify/a plugin rejected the request before it ever reached our own
    // handlers (bad JSON body, unsupported content-type, etc.) — a real client error, not a
    // crash, so its actual name/message should reach the client even in production. Only
    // genuine 5xx responses get logged as an error and have their message masked.
    if (statusCode >= 400 && statusCode < 500) {
      reply.status(statusCode).send({ error: error.name ?? "BadRequest", message });
      return;
    }

    request.log.error(error);
    reply.status(statusCode).send({
      error: "InternalServerError",
      message: process.env.NODE_ENV === "production" ? "Something went wrong" : message,
    });
  });

  fastify.register(cors, {
    origin: true,
    // @fastify/cors defaults to methods: 'GET,HEAD,POST' — every other verb the API
    // actually uses (PATCH, PUT, DELETE) must be listed explicitly or its preflight fails.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  });
  fastify.register(sensible);
  fastify.register(prismaPlugin);
  fastify.register(jwtPlugin);
  fastify.register(rbacPlugin);
  fastify.register(uploadsPlugin);

  fastify.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Order Tracking API",
        description: "QR-supported station workflow API for RasCorp production tracking.",
        version: "1.0.0",
      },
      servers: [
        { url: "http://localhost:3000", description: "Local" },
        { url: "http://51.79.159.222:8080", description: "Production" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      tags: [
        { name: "Auth", description: "Login and current-user identity" },
        { name: "Users", description: "Account management" },
        { name: "Roles", description: "Dynamic roles — each with a configurable set of permissions" },
        { name: "Permissions", description: "Fixed, code-defined permission catalog (read-only)" },
        { name: "Categories", description: "Product categories (car brands)" },
        { name: "Customers", description: "Customer records — must exist before being selected at order intake; also prep for an eventual client portal" },
        { name: "Products", description: "Product catalog — pricing, images, color lining options" },
        { name: "Stations", description: "Production stations — dynamic, ordered by sortOrder" },
        { name: "Orders", description: "Intake, dashboard listing, and order detail" },
        { name: "Scanning", description: "QR-driven station receive/outgoing transitions" },
        { name: "QC", description: "Quality-control decisions" },
        { name: "QC Rejection Reasons", description: "Management-configurable catalog of QC rejection/rework reasons, used on qc-decision and the QC metrics report" },
        { name: "Delivery", description: "Delivery outcomes and returns" },
        { name: "Concerns", description: "Structured concerns/clarifications raised on an order while checked in at a station — informational, never blocks the workflow" },
        { name: "Timeline & Reports", description: "Order history and turnaround reporting" },
        { name: "Activity", description: "Read-only audit log of auth events and admin/config changes — Management only" },
        { name: "Events", description: "Live Server-Sent Events (SSE) stream of order activity" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  fastify.register(swaggerUi, {
    routePrefix: "/docs",
  });

  fastify.register(
    async (api) => {
      api.register(healthRoutes);
      api.register(authRoutes, { prefix: "/auth" });
      api.register(usersRoutes, { prefix: "/users" });
      api.register(rolesRoutes, { prefix: "/roles" });
      api.register(permissionsRoutes, { prefix: "/permissions" });
      api.register(categoriesRoutes, { prefix: "/categories" });
      api.register(customersRoutes, { prefix: "/customers" });
      api.register(productsRoutes, { prefix: "/products" });
      api.register(promoCodesRoutes, { prefix: "/promo-codes" });
      api.register(stationsRoutes, { prefix: "/stations" });
      api.register(qcRejectionReasonsRoutes, { prefix: "/qc-rejection-reasons" });
      api.register(ordersRoutes, { prefix: "/orders" });
      api.register(timelineRoutes, { prefix: "/orders" });
      api.register(qcRoutes, { prefix: "/orders" });
      api.register(deliveryRoutes, { prefix: "/orders" });
      api.register(returnsRoutes, { prefix: "/orders" });
      api.register(concernsRoutes, { prefix: "/orders" });
      api.register(scanRoutes, { prefix: "/scan" });
      api.register(activityRoutes, { prefix: "/activity" });
      api.register(eventsRoutes, { prefix: "/events" });
    },
    { prefix: "/api/v1" },
  );

  return fastify;
}
