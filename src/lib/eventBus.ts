import { EventEmitter } from "node:events";
import type { OrderEventType } from "../generated/prisma/enums";

export interface OrderEventBroadcast {
  orderId: string;
  orderNumber: string;
  type: OrderEventType;
  stationId?: string | null;
  stationName?: string | null;
  message: string;
  actorUserId: string;
  createdAt: string;
}

/** In-process pub/sub for the live SSE stream (src/modules/events). A plain EventEmitter is
 * enough because this app runs as a single Fastify process (PM2 fork mode, not cluster) — see
 * plan.md §2. If this ever moves to multiple instances, this needs to become a real
 * message broker (Redis pub/sub etc.) instead. */
export const eventBus = new EventEmitter();
// Each open SSE connection adds one listener for as long as the client stays connected —
// that's expected, not a leak, so lift Node's default cap of 10 instead of warning on it.
eventBus.setMaxListeners(0);

/** Call only after the write that produced this event has committed (i.e. after the
 * surrounding prisma.$transaction has resolved) — never from inside the transaction itself,
 * so a client is never told about a change that could still roll back. */
export function publishOrderEvent(payload: OrderEventBroadcast) {
  eventBus.emit("order-event", payload);
}
