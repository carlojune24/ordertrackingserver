import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { streamQuerySchema } from "./events.schemas";
import { eventBus } from "../../lib/eventBus";
import { UnauthorizedError } from "../../lib/errors";

const HEARTBEAT_INTERVAL_MS = 25_000;

/** Same check as fastify.authenticate, plus a query-string fallback — the browser's native
 * EventSource API can't set an Authorization header, so this is the one route in the app
 * that also accepts the access token as ?token=. Authorization wins if both are present. */
async function authenticateStream(request: FastifyRequest<{ Querystring: { token?: string } }>) {
  const header = request.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const token = bearer ?? request.query.token;
  if (!token) {
    throw new UnauthorizedError("Missing authentication token");
  }
  try {
    request.user = request.server.jwt.verify(token);
  } catch {
    throw new UnauthorizedError("Missing or invalid authentication token");
  }
}

export default async function eventsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/stream",
    {
      preHandler: authenticateStream,
      schema: {
        tags: ["Events"],
        summary: "Live order-event stream (Server-Sent Events)",
        description:
          "Pushes an `order-event` SSE message for every new intake, station receive/outgoing, QC decision, rework routing, delivery outcome, return, and QR regeneration — the same actions recorded in each order's timeline, delivered live instead of polled. Any authenticated user can connect, same as GET /orders. EventSource can't set an Authorization header, so pass the access token as `?token=<jwt>` instead when connecting from a browser; curl or a fetch-based client can use the header as usual. No replay on reconnect — a client that was offline should re-fetch via GET /orders or GET /orders/:id/timeline to catch up on what it missed.",
        security: [{ bearerAuth: [] }],
        querystring: streamQuerySchema,
      },
    },
    async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Tells Nginx (see deploy/nginx-order-tracking.conf) not to buffer this response —
        // without it, events would sit in the proxy and never reach the client in production.
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": connected\n\n");

      const send = (payload: unknown) => {
        reply.raw.write(`event: order-event\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      eventBus.on("order-event", send);

      const heartbeat = setInterval(() => {
        reply.raw.write(": heartbeat\n\n");
      }, HEARTBEAT_INTERVAL_MS);

      request.raw.on("close", () => {
        clearInterval(heartbeat);
        eventBus.off("order-event", send);
      });
    },
  );
}
