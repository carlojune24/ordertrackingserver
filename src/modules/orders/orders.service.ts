import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { OrderEventType, OrderStatus } from "../../generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { nextOrderNumber } from "../../lib/orderNumber";
import { firstStation } from "../../lib/workflow";
import { promoDiscountAmount } from "../../lib/promo";
import { redeemPromoCode } from "../promoCodes/promoCodes.service";
import { publishOrderEvent } from "../../lib/eventBus";
import { assertCustomerNotArchived, getCustomerOrThrow } from "../customers/customers.service";

const ORDER_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true, email: true } },
  items: {
    include: {
      product: { include: { category: { select: { id: true, name: true } } } },
      colorLining: true,
    },
    orderBy: { createdAt: "asc" },
  },
  currentStation: {
    include: {
      // Who's currently in charge of this order — the active station workers assigned to
      // wherever it physically is right now, not just where it is.
      assignedWorkers: { where: { isActive: true }, select: { id: true, name: true, role: { select: { name: true } } } },
    },
  },
  assignedWorker: { select: { id: true, name: true } },
} satisfies Prisma.OrderInclude;

type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

export function isOverdue(order: Pick<OrderWithRelations, "deadline" | "status">): boolean {
  return order.status !== OrderStatus.DELIVERED && order.deadline.getTime() < Date.now();
}

function toOrderItemDto(item: OrderWithRelations["items"][number], orderNumber: string) {
  const { product, colorLining, ...rest } = item;
  return {
    ...rest,
    itemCode: `${orderNumber}-${item.itemNo}`,
    finalPrice: item.unitPrice - item.discountAmount,
    product: {
      id: product.id,
      name: product.name,
      description: product.description,
      categoryId: product.category.id,
      categoryName: product.category.name,
    },
    colorLining: colorLining ? { id: colorLining.id, label: colorLining.label } : null,
  };
}

/** subtotal/totalDiscount/promoDiscount/finalPrice are all computed on read from the order's
 * current items/promo snapshot, never stored — shared by toOrderDto and by the downPayment
 * validation/clamping logic below so both always agree on what finalPrice actually is. */
function computeOrderPricing(order: Pick<OrderWithRelations, "items" | "promoType" | "promoValue">) {
  const subtotal = order.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const totalDiscount = order.items.reduce((sum, i) => sum + i.discountAmount * i.quantity, 0);
  const promoDiscount = promoDiscountAmount(subtotal - totalDiscount, order);
  return { subtotal, totalDiscount, promoDiscount, finalPrice: subtotal - totalDiscount - promoDiscount };
}

export function toOrderDto(order: OrderWithRelations) {
  const { items, currentStation, assignedWorker, itemCounter: _itemCounter, promoCodeId: _promoCodeId, ...rest } = order;
  const itemDtos = items.map((item) => toOrderItemDto(item, order.orderNumber));
  const { subtotal, totalDiscount, promoDiscount, finalPrice } = computeOrderPricing(order);
  return {
    ...rest,
    hasPendingReplacement: itemDtos.some((i) => i.replacementStatus === "FLAGGED"),
    isOverdue: isOverdue(order),
    items: itemDtos,
    subtotal,
    totalDiscount,
    promoDiscount,
    finalPrice,
    assignedWorker: assignedWorker ? { id: assignedWorker.id, name: assignedWorker.name } : null,
    currentStation: currentStation
      ? {
          id: currentStation.id,
          name: currentStation.name,
          slug: currentStation.slug,
          logoUrl: currentStation.logoUrl,
          colorHex: currentStation.colorHex,
          isQcCheckpoint: currentStation.isQcCheckpoint,
          isSystem: currentStation.isSystem,
          assignedWorkers: currentStation.assignedWorkers.map((w) => ({
            id: w.id,
            name: w.name,
            roleName: w.role.name,
          })),
        }
      : null,
  };
}

/**
 * Validates that productId/colorLiningId form a legal, currently-active combination,
 * and returns the product so its current price can be snapshotted onto the order.
 */
async function resolveProduct(prisma: PrismaClient, productId: string, colorLiningId?: string | null) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { colorLinings: true },
  });
  if (!product || !product.isActive) {
    throw new ValidationError("productId does not reference an active product");
  }

  const activeLinings = product.colorLinings.filter((l) => l.isActive);

  if (colorLiningId) {
    const lining = activeLinings.find((l) => l.id === colorLiningId);
    if (!lining) {
      throw new ValidationError("colorLiningId does not reference an active color lining for this product");
    }
  } else if (activeLinings.length > 0) {
    throw new ValidationError("colorLiningId is required — this product has color lining options");
  }

  return product;
}

export interface IntakeItemInput {
  productId: string;
  colorLiningId?: string;
  quantity?: number;
  isCustomized?: boolean;
  unitPrice?: number;
  discountAmount?: number;
  discountReason?: string;
  note?: string;
}

export interface IntakeInput {
  customerId: string;
  items: IntakeItemInput[];
  proposedDurationDays: number;
  priority?: number;
  promoCode?: string;
  downPayment?: number;
}

/** Validates one item's product/lining pair, snapshots its price, and checks its discount
 * bound — shared by intake (each item in the array) and the post-intake item endpoints.
 * unitPrice auto-fills from the product's regularPrice or customizedPrice depending on
 * isCustomized, but an explicit input.unitPrice always wins — the checkbox just supplies
 * the default, front-end and staff can still override it. */
async function resolveOrderItem(prisma: PrismaClient, input: IntakeItemInput) {
  const product = await resolveProduct(prisma, input.productId, input.colorLiningId);
  const isCustomized = input.isCustomized ?? false;
  const regularPriceAtOrder = isCustomized ? product.customizedPrice : product.regularPrice;
  const autoUnitPrice = isCustomized ? product.customizedPrice : product.regularPrice;
  const unitPrice = input.unitPrice ?? autoUnitPrice;
  if (unitPrice < 0) {
    throw new ValidationError("unitPrice must not be negative");
  }
  const discountAmount = input.discountAmount ?? 0;
  if (discountAmount < 0 || discountAmount > unitPrice) {
    throw new ValidationError(`discountAmount must be between 0 and ${unitPrice}`);
  }
  return {
    productId: input.productId,
    colorLiningId: input.colorLiningId,
    quantity: input.quantity ?? 1,
    isCustomized,
    unitPrice,
    regularPriceAtOrder,
    discountAmount,
    discountReason: input.discountReason,
    note: input.note,
  };
}

export async function createOrder(prisma: PrismaClient, actorUserId: string, input: IntakeInput) {
  const customer = await getCustomerOrThrow(prisma, input.customerId);
  assertCustomerNotArchived(customer);

  if (input.items.length === 0) {
    throw new ValidationError("An order must have at least one item.");
  }
  const resolvedItems = await Promise.all(
    input.items.map(async (item, index) => ({ ...(await resolveOrderItem(prisma, item)), itemNo: index + 1 })),
  );
  const subtotal = resolvedItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const totalDiscount = resolvedItems.reduce((sum, i) => sum + i.discountAmount * i.quantity, 0);
  const downPayment = input.downPayment ?? 0;

  const stations = await prisma.station.findMany();
  const first = firstStation(stations);
  if (!first) {
    throw new ValidationError("No active stations are configured — an order cannot be routed anywhere.");
  }

  const { order, message } = await prisma.$transaction(async (tx) => {
    const orderNumber = await nextOrderNumber(tx);
    const orderDate = new Date();
    const deadline = new Date(orderDate.getTime() + input.proposedDurationDays * 24 * 60 * 60 * 1000);

    const promo = input.promoCode ? await redeemPromoCode(tx, input.promoCode) : null;

    const promoDiscount = promoDiscountAmount(subtotal - totalDiscount, {
      promoType: promo?.discountType ?? null,
      promoValue: promo?.value ?? null,
    });
    const finalPrice = subtotal - totalDiscount - promoDiscount;
    if (downPayment > finalPrice) {
      throw new ValidationError(`downPayment must not exceed the order's finalPrice (${finalPrice})`);
    }

    const created = await tx.order.create({
      data: {
        promoCodeId: promo?.id,
        promoCode: promo?.code,
        promoType: promo?.discountType,
        promoValue: promo?.value,
        orderNumber,
        customerId: input.customerId,
        orderDate,
        proposedDurationDays: input.proposedDurationDays,
        deadline,
        priority: input.priority,
        status: OrderStatus.IN_PROGRESS,
        currentStationId: first.id,
        isCheckedIn: false,
        createdByUserId: actorUserId,
        itemCounter: resolvedItems.length,
        downPayment,
        items: { create: resolvedItems },
      },
    });

    const message = `Order ${created.orderNumber} created at intake; awaiting ${first.name}.`;
    await tx.orderEvent.create({
      data: {
        orderId: created.id,
        type: OrderEventType.INTAKE_CREATED,
        stationId: first.id,
        actorUserId,
        message,
      },
    });

    return { order: created, message };
  });

  publishOrderEvent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    type: OrderEventType.INTAKE_CREATED,
    stationId: first.id,
    stationName: first.name,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  return getOrderOrThrow(prisma, order.id);
}

export async function getOrderOrThrow(prisma: PrismaClient, id: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
  if (!order) throw new NotFoundError("Order not found");
  return order;
}

/** Archived orders are fully frozen — call this from every mutating order action
 * (edit, scan, QC, delivery) so an archived order can't drift further once hidden. */
export function assertNotArchived(order: Pick<OrderWithRelations, "isArchived" | "orderNumber">) {
  if (order.isArchived) {
    throw new ConflictError(`Order ${order.orderNumber} is archived — unarchive it first.`);
  }
}

export interface ListOrdersFilter {
  status?: OrderStatus;
  stationId?: string;
  priority?: number;
  overdue?: boolean;
  categoryId?: string;
  customerId?: string;
  search?: string;
  includeArchived?: boolean;
  archivedOnly?: boolean;
  isCheckedIn?: boolean;
  pendingReplacement?: boolean;
  page: number;
  pageSize: number;
}

export async function listOrders(prisma: PrismaClient, filter: ListOrdersFilter) {
  const where: Prisma.OrderWhereInput = {};
  if (filter.archivedOnly) {
    where.isArchived = true;
  } else if (!filter.includeArchived) {
    where.isArchived = false;
  }
  if (filter.status) where.status = filter.status;
  if (filter.stationId) where.currentStationId = filter.stationId;
  if (filter.isCheckedIn !== undefined) where.isCheckedIn = filter.isCheckedIn;
  if (filter.priority) where.priority = filter.priority;
  if (filter.categoryId) where.items = { some: { product: { categoryId: filter.categoryId } } };
  if (filter.customerId) where.customerId = filter.customerId;
  if (filter.pendingReplacement) where.items = { some: { replacementStatus: "FLAGGED" } };
  if (filter.overdue) {
    where.status = { not: OrderStatus.DELIVERED };
    where.deadline = { lt: new Date() };
  }
  if (filter.search) {
    where.OR = [
      { orderNumber: { contains: filter.search, mode: "insensitive" } },
      { customer: { name: { contains: filter.search, mode: "insensitive" } } },
      { items: { some: { product: { name: { contains: filter.search, mode: "insensitive" } } } } },
    ];
  }

  const [items, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: [{ priority: "asc" }, { deadline: "asc" }],
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return { items, total };
}

export interface CompletedOrdersForUserFilter {
  page: number;
  pageSize: number;
}

/** "Completed orders under this user's name" = orders where this user physically scanned
 * a receive or outgoing at some StationVisit — not createdByUserId, not QC/delivery actor,
 * not station assignment. Excludes archived orders; no toggle, this is a summary view. */
export async function listCompletedOrdersForUser(
  prisma: PrismaClient,
  userId: string,
  filter: CompletedOrdersForUserFilter,
) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new NotFoundError("User not found");

  const visits = await prisma.stationVisit.findMany({
    where: { OR: [{ receivedByUserId: userId }, { outgoingByUserId: userId }] },
    select: { orderId: true },
    distinct: ["orderId"],
  });
  const orderIds = visits.map((v) => v.orderId);

  const where: Prisma.OrderWhereInput = { id: { in: orderIds }, status: OrderStatus.DELIVERED, isArchived: false };
  const [items, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: [{ deadline: "desc" }],
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return { items, total };
}

export interface UpdateOrderInput {
  customerId?: string;
  proposedDurationDays?: number;
  priority?: number | null;
  downPayment?: number;
}

export async function updateOrder(prisma: PrismaClient, id: string, actorUserId: string, input: UpdateOrderInput) {
  const existing = await getOrderOrThrow(prisma, id);
  assertNotArchived(existing);

  if (input.customerId) {
    const customer = await getCustomerOrThrow(prisma, input.customerId);
    assertCustomerNotArchived(customer);
  }

  let deadline: Date | undefined;
  if (input.proposedDurationDays !== undefined) {
    deadline = new Date(existing.orderDate.getTime() + input.proposedDurationDays * 24 * 60 * 60 * 1000);
  }

  const downPaymentChanged = input.downPayment !== undefined && input.downPayment !== existing.downPayment;
  if (input.downPayment !== undefined) {
    const { finalPrice } = computeOrderPricing(existing);
    if (input.downPayment > finalPrice) {
      throw new ValidationError(`downPayment must not exceed the order's finalPrice (${finalPrice})`);
    }
  }

  const message = `Down payment updated to ${input.downPayment} on order ${existing.orderNumber}.`;
  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id },
      data: {
        customerId: input.customerId,
        proposedDurationDays: input.proposedDurationDays,
        priority: input.priority,
        deadline,
        downPayment: input.downPayment,
      },
    });
    if (downPaymentChanged) {
      await tx.orderEvent.create({
        data: { orderId: id, type: OrderEventType.DOWN_PAYMENT_UPDATED, actorUserId, message },
      });
    }
  });

  if (downPaymentChanged) {
    publishOrderEvent({
      orderId: id,
      orderNumber: existing.orderNumber,
      type: OrderEventType.DOWN_PAYMENT_UPDATED,
      stationId: null,
      stationName: null,
      message,
      actorUserId,
      createdAt: new Date().toISOString(),
    });
  }

  return getOrderOrThrow(prisma, id);
}

export interface AddOrderItemInput {
  productId: string;
  colorLiningId?: string;
  quantity?: number;
  isCustomized?: boolean;
  unitPrice?: number;
  discountAmount?: number;
  discountReason?: string;
  note?: string;
}

export async function addOrderItem(prisma: PrismaClient, orderId: string, actorUserId: string, input: AddOrderItemInput) {
  const order = await getOrderOrThrow(prisma, orderId);
  assertNotArchived(order);

  const resolved = await resolveOrderItem(prisma, input);

  const message = await prisma.$transaction(async (tx) => {
    // itemCounter only ever increments — never derived from COUNT/MAX of currently-existing
    // items, since items can be removed and COUNT/MAX would then hand out an already-used
    // number. The atomic increment also means a concurrent add can't race to the same number.
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { itemCounter: { increment: 1 } },
      select: { itemCounter: true },
    });
    const item = await tx.orderItem.create({ data: { orderId, ...resolved, itemNo: updated.itemCounter } });
    const message = `Item added: ${resolved.quantity}x item #${item.itemNo} on order ${order.orderNumber}.`;
    await tx.orderEvent.create({
      data: { orderId, type: OrderEventType.ITEM_ADDED, actorUserId, message, metadata: { orderItemId: item.id } },
    });
    return message;
  });

  publishOrderEvent({
    orderId,
    orderNumber: order.orderNumber,
    type: OrderEventType.ITEM_ADDED,
    stationId: null,
    stationName: null,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  return getOrderOrThrow(prisma, orderId);
}

export interface UpdateOrderItemInput {
  productId?: string;
  colorLiningId?: string | null;
  quantity?: number;
  isCustomized?: boolean;
  unitPrice?: number;
  discountAmount?: number;
  discountReason?: string | null;
  note?: string | null;
}

/** Called after any item edit/removal that can lower finalPrice — an item add never lowers it,
 * so this is only wired into updateOrderItem/removeOrderItem. Clamps downPayment down to the
 * new finalPrice rather than leaving it stranded above it, and records why via a
 * DOWN_PAYMENT_UPDATED event, same as an explicit PATCH /orders/:id downPayment change. */
async function clampDownPaymentIfNeeded(prisma: PrismaClient, orderId: string, actorUserId: string) {
  const order = await getOrderOrThrow(prisma, orderId);
  const { finalPrice } = computeOrderPricing(order);
  if (order.downPayment <= finalPrice) return;

  const message = `Down payment automatically lowered to ${finalPrice} to match order ${order.orderNumber}'s reduced final price.`;
  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { downPayment: finalPrice } });
    await tx.orderEvent.create({
      data: { orderId, type: OrderEventType.DOWN_PAYMENT_UPDATED, actorUserId, message },
    });
  });

  publishOrderEvent({
    orderId,
    orderNumber: order.orderNumber,
    type: OrderEventType.DOWN_PAYMENT_UPDATED,
    stationId: null,
    stationName: null,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });
}

async function getOrderItemOrThrow(prisma: PrismaClient, orderId: string, itemId: string) {
  const item = await prisma.orderItem.findUnique({ where: { id: itemId } });
  if (!item || item.orderId !== orderId) throw new NotFoundError("Order item not found");
  return item;
}

/** Validates that every given id references an item on this order — used before linking
 * ReworkRouteItem rows to a rework decision, by both scan.service.ts (station rejection)
 * and qc.service.ts (formal QC decisions). */
export async function assertOrderItemsBelongToOrder(prisma: PrismaClient, orderId: string, orderItemIds: string[]) {
  const items = await prisma.orderItem.findMany({ where: { orderId, id: { in: orderItemIds } }, select: { id: true } });
  if (items.length !== orderItemIds.length) {
    throw new ValidationError("orderItemIds must all reference items on this order");
  }
}

export async function updateOrderItem(
  prisma: PrismaClient,
  orderId: string,
  itemId: string,
  actorUserId: string,
  input: UpdateOrderItemInput,
) {
  const order = await getOrderOrThrow(prisma, orderId);
  assertNotArchived(order);
  const existing = await getOrderItemOrThrow(prisma, orderId, itemId);

  const isCustomizedChanged = input.isCustomized !== undefined && input.isCustomized !== existing.isCustomized;

  let unitPrice: number | undefined = input.unitPrice;
  let regularPriceAtOrder: number | undefined;
  if (input.productId || input.colorLiningId !== undefined || isCustomizedChanged) {
    const productId = input.productId ?? existing.productId;
    const colorLiningId = input.colorLiningId !== undefined ? input.colorLiningId : existing.colorLiningId;
    const product = await resolveProduct(prisma, productId, colorLiningId);
    const isCustomized = input.isCustomized ?? existing.isCustomized;
    // Re-snapshot pricing only when the product itself changes or the regular/customized
    // toggle flips — editing just the color lining, or nothing at all, must never alter
    // what was already charged. An explicit unitPrice always wins over the auto-derived one.
    if ((input.productId && input.productId !== existing.productId) || isCustomizedChanged) {
      regularPriceAtOrder = isCustomized ? product.customizedPrice : product.regularPrice;
      if (unitPrice === undefined) {
        unitPrice = isCustomized ? product.customizedPrice : product.regularPrice;
      }
    }
  }
  if (unitPrice !== undefined && unitPrice < 0) {
    throw new ValidationError("unitPrice must not be negative");
  }

  let discountAmount = input.discountAmount;
  const effectiveUnitPrice = unitPrice ?? existing.unitPrice;
  if (discountAmount !== undefined) {
    if (discountAmount < 0 || discountAmount > effectiveUnitPrice) {
      throw new ValidationError(`discountAmount must be between 0 and ${effectiveUnitPrice}`);
    }
  } else if (unitPrice !== undefined && existing.discountAmount > effectiveUnitPrice) {
    // The price just changed to something cheaper than the existing discount —
    // silently carrying that discount forward would make finalPrice negative.
    discountAmount = 0;
  }

  const message = await prisma.$transaction(async (tx) => {
    await tx.orderItem.update({
      where: { id: itemId },
      data: {
        productId: input.productId,
        colorLiningId: input.colorLiningId,
        quantity: input.quantity,
        isCustomized: input.isCustomized,
        unitPrice,
        regularPriceAtOrder,
        discountAmount,
        discountReason: input.discountReason,
        note: input.note,
      },
    });
    const message = `Item updated on order ${order.orderNumber}.`;
    await tx.orderEvent.create({
      data: { orderId, type: OrderEventType.ITEM_UPDATED, actorUserId, message, metadata: { orderItemId: itemId } },
    });
    return message;
  });

  publishOrderEvent({
    orderId,
    orderNumber: order.orderNumber,
    type: OrderEventType.ITEM_UPDATED,
    stationId: null,
    stationName: null,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  await clampDownPaymentIfNeeded(prisma, orderId, actorUserId);

  return getOrderOrThrow(prisma, orderId);
}

export async function removeOrderItem(prisma: PrismaClient, orderId: string, itemId: string, actorUserId: string) {
  const order = await getOrderOrThrow(prisma, orderId);
  assertNotArchived(order);
  await getOrderItemOrThrow(prisma, orderId, itemId);

  if (order.items.length <= 1) {
    throw new ConflictError("An order must have at least one item — remove the whole order instead.");
  }

  const reworkLinkCount = await prisma.reworkRouteItem.count({ where: { orderItemId: itemId } });
  if (reworkLinkCount > 0) {
    throw new ConflictError("This item has already been flagged in a rework decision and can't be removed — its history would be orphaned.");
  }

  const message = await prisma.$transaction(async (tx) => {
    await tx.orderItem.delete({ where: { id: itemId } });
    const message = `Item removed from order ${order.orderNumber}.`;
    await tx.orderEvent.create({
      data: { orderId, type: OrderEventType.ITEM_REMOVED, actorUserId, message, metadata: { orderItemId: itemId } },
    });
    return message;
  });

  publishOrderEvent({
    orderId,
    orderNumber: order.orderNumber,
    type: OrderEventType.ITEM_REMOVED,
    stationId: null,
    stationName: null,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  await clampDownPaymentIfNeeded(prisma, orderId, actorUserId);

  return getOrderOrThrow(prisma, orderId);
}

/** Idempotent — archiving an already-archived order just returns it as-is, no duplicate event. */
export async function archiveOrder(prisma: PrismaClient, id: string, actorUserId: string) {
  const existing = await getOrderOrThrow(prisma, id);
  if (existing.isArchived) return existing;

  const message = `Order ${existing.orderNumber} archived.`;
  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id }, data: { isArchived: true, archivedAt: new Date() } });
    await tx.orderEvent.create({
      data: { orderId: id, type: OrderEventType.ARCHIVED, actorUserId, message },
    });
  });

  publishOrderEvent({
    orderId: id,
    orderNumber: existing.orderNumber,
    type: OrderEventType.ARCHIVED,
    stationId: null,
    stationName: null,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  return getOrderOrThrow(prisma, id);
}

/** Idempotent — unarchiving an already-active order just returns it as-is, no duplicate event. */
export async function unarchiveOrder(prisma: PrismaClient, id: string, actorUserId: string) {
  const existing = await getOrderOrThrow(prisma, id);
  if (!existing.isArchived) return existing;

  const message = `Order ${existing.orderNumber} unarchived.`;
  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id }, data: { isArchived: false, archivedAt: null } });
    await tx.orderEvent.create({
      data: { orderId: id, type: OrderEventType.UNARCHIVED, actorUserId, message },
    });
  });

  publishOrderEvent({
    orderId: id,
    orderNumber: existing.orderNumber,
    type: OrderEventType.UNARCHIVED,
    stationId: null,
    stationName: null,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  return getOrderOrThrow(prisma, id);
}

export interface OverrideStationInput {
  stationId: string;
  /** string = pin to this worker; null = explicitly clear; undefined = clear (same as null) —
   * a pin never survives a station change unless re-supplied, since the old pin's worker may
   * not belong to the new station. */
  assignedWorkerUserId?: string | null;
  reason?: string;
}

/**
 * Management-only admin escape hatch — repoints an order at any active station (including the
 * fixed QC/Packaging/Courier system stages, unlike every other transition in this app) without going
 * through the real scan/QC/delivery workflow. Marks the order as physically checked in there
 * (closes any open StationVisit, opens a new one) and can pin it to one specific worker already
 * assigned to that station. Every use still writes a single OrderEvent so it's never a silent
 * hole in the timeline.
 */
export async function overrideStation(
  prisma: PrismaClient,
  id: string,
  actorUserId: string,
  input: OverrideStationInput,
) {
  const order = await getOrderOrThrow(prisma, id);
  assertNotArchived(order);

  const station = await prisma.station.findUnique({ where: { id: input.stationId } });
  if (!station) throw new NotFoundError("Station not found");
  if (!station.isActive) throw new ConflictError(`${station.name} is inactive and can't be overridden to.`);

  let assignedWorkerUserId: string | null = null;
  if (input.assignedWorkerUserId) {
    const worker = await prisma.user.findUnique({ where: { id: input.assignedWorkerUserId } });
    if (!worker || !worker.isActive) {
      throw new ValidationError("assignedWorkerUserId does not reference an active user");
    }
    if (worker.assignedStationId !== station.id) {
      throw new ValidationError(`${worker.name} is not assigned to ${station.name}`);
    }
    assignedWorkerUserId = worker.id;
  }

  const fromStationId = order.currentStationId;
  const previousAssignedWorkerUserId = order.assignedWorkerUserId;

  const message = await prisma.$transaction(async (tx) => {
    if (order.isCheckedIn && order.currentStationId) {
      const openVisit = await tx.stationVisit.findFirst({
        where: { orderId: order.id, stationId: order.currentStationId, outgoingAt: null },
        orderBy: { sequenceNo: "desc" },
      });
      if (openVisit) {
        await tx.stationVisit.update({
          where: { id: openVisit.id },
          data: { outgoingAt: new Date(), outgoingByUserId: actorUserId },
        });
      }
    }

    const existingVisits = await tx.stationVisit.count({ where: { orderId: order.id, stationId: station.id } });
    const sequenceNo = existingVisits + 1;
    await tx.stationVisit.create({
      data: {
        orderId: order.id,
        stationId: station.id,
        sequenceNo,
        receivedAt: new Date(),
        receivedByUserId: actorUserId,
        isReworkVisit: sequenceNo > 1,
      },
    });

    await tx.order.update({
      where: { id: order.id },
      data: { currentStationId: station.id, isCheckedIn: true, assignedWorkerUserId },
    });

    const message = `Admin override: moved to ${station.name}${assignedWorkerUserId ? " and assigned to a specific worker" : ""}${input.reason ? ` — ${input.reason}` : ""}.`;
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: OrderEventType.STATION_OVERRIDDEN,
        stationId: station.id,
        actorUserId,
        message,
        metadata: { fromStationId, toStationId: station.id, previousAssignedWorkerUserId, assignedWorkerUserId, reason: input.reason ?? null },
      },
    });

    return message;
  });

  publishOrderEvent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    type: OrderEventType.STATION_OVERRIDDEN,
    stationId: station.id,
    stationName: station.name,
    message,
    actorUserId,
    createdAt: new Date().toISOString(),
  });

  return getOrderOrThrow(prisma, order.id);
}
