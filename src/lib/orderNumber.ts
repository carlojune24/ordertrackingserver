import type { Prisma } from "../generated/prisma/client";

/**
 * Atomically allocates the next order number for the given year, e.g. "RC-2026-000001".
 * Must be called with a transaction client so the increment is race-free under concurrent intake.
 */
export async function nextOrderNumber(tx: Prisma.TransactionClient, year = new Date().getFullYear()): Promise<string> {
  const key = `order-${year}`;
  const counter = await tx.counter.upsert({
    where: { key },
    create: { key, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `RC-${year}-${String(counter.value).padStart(6, "0")}`;
}
