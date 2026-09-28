import QRCode from "qrcode";
import type { PrismaClient } from "../../generated/prisma/client";
import { OrderEventType } from "../../generated/prisma/enums";
import { assertNotArchived, getOrderOrThrow } from "../orders/orders.service";
import { publishOrderEvent } from "../../lib/eventBus";

/** Renders the order's QR as a PNG buffer, suitable for printing on a job ticket/fabric tag. */
export async function renderOrderQrPng(qrToken: string): Promise<Buffer> {
  return QRCode.toBuffer(qrToken, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 320 });
}

/** Rotates an order's QR token (e.g. a physical tag was lost/damaged) without renumbering the order. */
export async function regenerateOrderQr(prisma: PrismaClient, orderId: string, actorUserId: string) {
  const order = await getOrderOrThrow(prisma, orderId);
  assertNotArchived(order);
  const { randomUUID } = await import("node:crypto");

  const { orderNumber, message } = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({ where: { id: orderId }, data: { qrToken: randomUUID() } });

    const message = `QR token regenerated for order ${updated.orderNumber}.`;
    await tx.orderEvent.create({
      data: {
        orderId,
        type: OrderEventType.QR_REGENERATED,
        actorUserId,
        message,
      },
    });

    return { orderNumber: updated.orderNumber, message };
  });

  publishOrderEvent({
    orderId,
    orderNumber,
    type: OrderEventType.QR_REGENERATED,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  return getOrderOrThrow(prisma, orderId);
}
