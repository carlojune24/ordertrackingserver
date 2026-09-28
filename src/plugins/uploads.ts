import fp from "fastify-plugin";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { ensureUploadDirs, UPLOAD_ROOT } from "../lib/imageUpload";

// Matches Nginx's client_max_body_size 5m (deploy/nginx-order-tracking.conf) — keeping these
// in sync means an oversized upload gets a clean 413 from the app instead of a raw
// connection reset from the proxy.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export default fp(async (fastify: FastifyInstance) => {
  await ensureUploadDirs();

  await fastify.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  // Serves everything under uploads/ (e.g. uploads/products/<file>, uploads/categories/<file>)
  // at the matching /uploads/<namespace>/<file> path, publicly and without auth — matches how
  // an externally-hosted image URL already behaves today (no auth gate on viewing an
  // already-public link).
  await fastify.register(fastifyStatic, {
    root: UPLOAD_ROOT,
    prefix: "/uploads/",
  });
});
