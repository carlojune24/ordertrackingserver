import type { Customer, Prisma, PrismaClient } from "../../generated/prisma/client";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";

export async function getCustomerOrThrow(prisma: PrismaClient, id: string) {
  const customer = await prisma.customer.findUnique({ where: { id } });
  if (!customer) throw new NotFoundError("Customer not found");
  return customer;
}

/** Archived customers are fully frozen — call this before letting a customer be edited, or
 * selected for a new/edited order, so an archived customer can't drift further once hidden. */
export function assertCustomerNotArchived(customer: Pick<Customer, "isArchived" | "name">) {
  if (customer.isArchived) {
    throw new ConflictError(`Customer ${customer.name} is archived — unarchive it first.`);
  }
}

function toCustomerDto<T extends { _count: { orders: number } }>(customer: T) {
  const { _count, ...rest } = customer;
  return { ...rest, orderCount: _count.orders };
}

export interface ListCustomersFilter {
  search?: string;
  includeArchived?: boolean;
  archivedOnly?: boolean;
  page: number;
  pageSize: number;
}

export async function listCustomers(prisma: PrismaClient, filter: ListCustomersFilter) {
  const where: Prisma.CustomerWhereInput = {};
  if (filter.archivedOnly) {
    where.isArchived = true;
  } else if (!filter.includeArchived) {
    where.isArchived = false;
  }
  if (filter.search) {
    where.OR = [
      { name: { contains: filter.search, mode: "insensitive" } },
      { phone: { contains: filter.search, mode: "insensitive" } },
      { email: { contains: filter.search, mode: "insensitive" } },
    ];
  }

  const [customers, total] = await prisma.$transaction([
    prisma.customer.findMany({
      where,
      include: { _count: { select: { orders: true } } },
      orderBy: { createdAt: "desc" },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    prisma.customer.count({ where }),
  ]);

  return { items: customers.map(toCustomerDto), total };
}

export async function getCustomerDetail(prisma: PrismaClient, id: string) {
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: { _count: { select: { orders: true } } },
  });
  if (!customer) throw new NotFoundError("Customer not found");
  return toCustomerDto(customer);
}

export interface CreateCustomerInput {
  name: string;
  phone?: string;
  email?: string;
}

export async function createCustomer(prisma: PrismaClient, input: CreateCustomerInput) {
  if (input.email) {
    const existing = await prisma.customer.findUnique({ where: { email: input.email } });
    if (existing) throw new ValidationError("A customer with this email already exists");
  }

  const customer = await prisma.customer.create({
    data: { name: input.name, phone: input.phone, email: input.email },
    include: { _count: { select: { orders: true } } },
  });
  return toCustomerDto(customer);
}

export interface UpdateCustomerInput {
  name?: string;
  phone?: string | null;
  email?: string | null;
}

export async function updateCustomer(prisma: PrismaClient, id: string, input: UpdateCustomerInput) {
  const existing = await getCustomerOrThrow(prisma, id);
  assertCustomerNotArchived(existing);

  if (input.email) {
    const conflict = await prisma.customer.findFirst({ where: { id: { not: id }, email: input.email } });
    if (conflict) throw new ValidationError("A customer with this email already exists");
  }

  const customer = await prisma.customer.update({
    where: { id },
    data: { name: input.name, phone: input.phone, email: input.email },
    include: { _count: { select: { orders: true } } },
  });
  return toCustomerDto(customer);
}

/** Idempotent — archiving an already-archived customer just returns it as-is. */
export async function archiveCustomer(prisma: PrismaClient, id: string) {
  const existing = await getCustomerOrThrow(prisma, id);
  if (existing.isArchived) return getCustomerDetail(prisma, id);

  await prisma.customer.update({ where: { id }, data: { isArchived: true, archivedAt: new Date() } });
  return getCustomerDetail(prisma, id);
}

/** Idempotent — unarchiving an already-active customer just returns it as-is. */
export async function unarchiveCustomer(prisma: PrismaClient, id: string) {
  const existing = await getCustomerOrThrow(prisma, id);
  if (!existing.isArchived) return getCustomerDetail(prisma, id);

  await prisma.customer.update({ where: { id }, data: { isArchived: false, archivedAt: null } });
  return getCustomerDetail(prisma, id);
}
