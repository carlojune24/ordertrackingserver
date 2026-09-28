import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { recordActivity } from "../../lib/activityLog";
import { deleteUploadedImageIfLocal, saveUploadedImage } from "../../lib/imageUpload";

const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true, slug: true } },
  images: { orderBy: { sortOrder: "asc" as const } },
  colorLinings: { orderBy: { sortOrder: "asc" as const } },
} satisfies Prisma.ProductInclude;

export interface ListProductsFilter {
  categoryId?: string;
  includeInactive?: boolean;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listProducts(prisma: PrismaClient, filter: ListProductsFilter) {
  const where: Prisma.ProductWhereInput = {};
  if (filter.categoryId) where.categoryId = filter.categoryId;
  if (!filter.includeInactive) where.isActive = true;
  if (filter.search) {
    where.OR = [
      { name: { contains: filter.search, mode: "insensitive" } },
      { description: { contains: filter.search, mode: "insensitive" } },
    ];
  }

  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      include: PRODUCT_INCLUDE,
      orderBy: [{ name: "asc" }],
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    prisma.product.count({ where }),
  ]);

  return { items, total };
}

export async function getProductOrThrow(prisma: PrismaClient, id: string) {
  const product = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
  if (!product) throw new NotFoundError("Product not found");
  return product;
}

async function assertCategoryExists(prisma: PrismaClient, categoryId: string) {
  const category = await prisma.productCategory.findUnique({ where: { id: categoryId } });
  if (!category) throw new ValidationError("categoryId does not reference an existing category");
}

export interface CreateProductInput {
  categoryId: string;
  name: string;
  description?: string;
  regularPrice: number;
  customizedPrice: number;
  rating?: number;
  images?: { url: string; sortOrder?: number; isPrimary?: boolean }[];
  colorLinings?: { label: string; sortOrder?: number }[];
}

export async function createProduct(prisma: PrismaClient, actorUserId: string, input: CreateProductInput) {
  await assertCategoryExists(prisma, input.categoryId);

  const created = await prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        categoryId: input.categoryId,
        name: input.name,
        description: input.description,
        regularPrice: input.regularPrice,
        customizedPrice: input.customizedPrice,
        rating: input.rating,
        images: input.images?.length ? { create: input.images } : undefined,
        colorLinings: input.colorLinings?.length ? { create: input.colorLinings } : undefined,
      },
    });

    await tx.productPriceHistory.create({
      data: {
        productId: product.id,
        regularPrice: product.regularPrice,
        customizedPrice: product.customizedPrice,
        changedByUserId: actorUserId,
      },
    });

    await recordActivity(tx, {
      action: "CREATED",
      entityType: "PRODUCT",
      entityId: product.id,
      actorUserId,
      message: `Product ${product.name} created.`,
    });

    return product;
  });

  return getProductOrThrow(prisma, created.id);
}

export interface UpdateProductInput {
  categoryId?: string;
  name?: string;
  description?: string | null;
  regularPrice?: number;
  customizedPrice?: number;
  rating?: number | null;
  isActive?: boolean;
}

export async function updateProduct(prisma: PrismaClient, id: string, actorUserId: string, input: UpdateProductInput) {
  const existing = await getProductOrThrow(prisma, id);

  if (input.categoryId) await assertCategoryExists(prisma, input.categoryId);

  const effectiveRegularPrice = input.regularPrice ?? existing.regularPrice;
  const effectiveCustomizedPrice = input.customizedPrice ?? existing.customizedPrice;

  const priceChanged =
    (input.regularPrice !== undefined && input.regularPrice !== existing.regularPrice) ||
    (input.customizedPrice !== undefined && input.customizedPrice !== existing.customizedPrice);

  await prisma.$transaction(async (tx) => {
    const product = await tx.product.update({
      where: { id },
      data: {
        categoryId: input.categoryId,
        name: input.name,
        description: input.description,
        regularPrice: input.regularPrice,
        customizedPrice: input.customizedPrice,
        rating: input.rating,
        isActive: input.isActive,
      },
    });

    if (priceChanged) {
      await tx.productPriceHistory.create({
        data: {
          productId: id,
          regularPrice: effectiveRegularPrice,
          customizedPrice: effectiveCustomizedPrice,
          changedByUserId: actorUserId,
        },
      });
    }

    await recordActivity(tx, {
      action: "UPDATED",
      entityType: "PRODUCT",
      entityId: product.id,
      actorUserId,
      message: `Product ${product.name} updated.`,
    });
  });

  return getProductOrThrow(prisma, id);
}

export async function getProductPriceHistory(prisma: PrismaClient, productId: string) {
  await getProductOrThrow(prisma, productId);

  const history = await prisma.productPriceHistory.findMany({
    where: { productId },
    orderBy: { createdAt: "desc" },
  });

  const actorIds = [...new Set(history.map((h) => h.changedByUserId))];
  const actors = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, name: true, role: { select: { name: true } } },
  });
  const actorById = new Map(actors.map((a) => [a.id, { id: a.id, name: a.name, roleName: a.role.name }]));

  return history.map((entry) => ({
    id: entry.id,
    regularPrice: entry.regularPrice,
    customizedPrice: entry.customizedPrice,
    createdAt: entry.createdAt,
    changedBy: actorById.get(entry.changedByUserId) ?? { id: entry.changedByUserId, name: "Unknown", roleName: null },
  }));
}

export async function addProductImage(
  prisma: PrismaClient,
  productId: string,
  input: { url: string; sortOrder?: number; isPrimary?: boolean },
) {
  await getProductOrThrow(prisma, productId);
  await prisma.productImage.create({
    data: { productId, url: input.url, sortOrder: input.sortOrder ?? 0, isPrimary: input.isPrimary ?? false },
  });
  return getProductOrThrow(prisma, productId);
}

export async function removeProductImage(prisma: PrismaClient, productId: string, imageId: string) {
  const image = await prisma.productImage.findUnique({ where: { id: imageId } });
  if (!image || image.productId !== productId) throw new NotFoundError("Product image not found");

  await prisma.productImage.delete({ where: { id: imageId } });
  await deleteUploadedImageIfLocal(image.url);
  return getProductOrThrow(prisma, productId);
}

/** Same as addProductImage, but the image bytes come from a multipart upload (see
 * products.routes.ts) instead of an already-hosted url — saves the file locally first,
 * then reuses the exact same DB-row logic below. */
export async function uploadProductImage(prisma: PrismaClient, productId: string, buffer: Buffer) {
  await getProductOrThrow(prisma, productId); // 404 early, before writing anything to disk
  const { url } = await saveUploadedImage("products", buffer);
  return addProductImage(prisma, productId, { url });
}

export async function addColorLining(prisma: PrismaClient, productId: string, input: { label: string; sortOrder?: number }) {
  await getProductOrThrow(prisma, productId);

  const existing = await prisma.productColorLining.findUnique({
    where: { productId_label: { productId, label: input.label } },
  });
  if (existing) throw new ValidationError("This product already has a color lining with that label");

  await prisma.productColorLining.create({
    data: { productId, label: input.label, sortOrder: input.sortOrder ?? 0 },
  });
  return getProductOrThrow(prisma, productId);
}

export async function updateColorLining(
  prisma: PrismaClient,
  productId: string,
  liningId: string,
  input: { label?: string; sortOrder?: number; isActive?: boolean },
) {
  const lining = await prisma.productColorLining.findUnique({ where: { id: liningId } });
  if (!lining || lining.productId !== productId) throw new NotFoundError("Color lining not found");

  await prisma.productColorLining.update({
    where: { id: liningId },
    data: { label: input.label, sortOrder: input.sortOrder, isActive: input.isActive },
  });
  return getProductOrThrow(prisma, productId);
}
