import type { PrismaClient } from "../../generated/prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { recordActivity } from "../../lib/activityLog";
import { slugify } from "../../lib/slugify";
import { deleteUploadedImageIfLocal, saveUploadedImage } from "../../lib/imageUpload";

export function listCategories(prisma: PrismaClient, includeInactive?: boolean) {
  return prisma.productCategory.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export interface CreateCategoryInput {
  name: string;
  slug?: string;
  sortOrder?: number;
  logoUrl?: string;
}

export async function createCategory(prisma: PrismaClient, actorUserId: string, input: CreateCategoryInput) {
  const slug = input.slug ?? slugify(input.name);

  const existing = await prisma.productCategory.findFirst({
    where: { OR: [{ name: input.name }, { slug }] },
  });
  if (existing) {
    throw new ValidationError("A category with this name or slug already exists");
  }

  return prisma.$transaction(async (tx) => {
    const category = await tx.productCategory.create({
      data: { name: input.name, slug, sortOrder: input.sortOrder ?? 0, logoUrl: input.logoUrl },
    });

    await recordActivity(tx, {
      action: "CREATED",
      entityType: "CATEGORY",
      entityId: category.id,
      actorUserId,
      message: `Category ${category.name} created.`,
    });

    return category;
  });
}

export interface UpdateCategoryInput {
  name?: string;
  slug?: string;
  sortOrder?: number;
  isActive?: boolean;
  logoUrl?: string | null;
}

export async function updateCategory(
  prisma: PrismaClient,
  id: string,
  actorUserId: string,
  input: UpdateCategoryInput,
) {
  const existing = await prisma.productCategory.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Category not found");

  if (input.name || input.slug) {
    const conflict = await prisma.productCategory.findFirst({
      where: {
        id: { not: id },
        OR: [input.name ? { name: input.name } : undefined, input.slug ? { slug: input.slug } : undefined].filter(
          Boolean,
        ) as object[],
      },
    });
    if (conflict) throw new ValidationError("A category with this name or slug already exists");
  }

  const category = await prisma.$transaction(async (tx) => {
    const category = await tx.productCategory.update({
      where: { id },
      data: { name: input.name, slug: input.slug, sortOrder: input.sortOrder, isActive: input.isActive, logoUrl: input.logoUrl },
    });

    await recordActivity(tx, {
      action: "UPDATED",
      entityType: "CATEGORY",
      entityId: category.id,
      actorUserId,
      message: `Category ${category.name} updated.`,
    });

    return category;
  });

  // Only once the new value is durably committed — never delete the old file first, in case
  // the update itself fails (e.g. a name/slug conflict caught above, or the transaction
  // rolling back for some other reason).
  if (input.logoUrl !== undefined && existing.logoUrl && existing.logoUrl !== input.logoUrl) {
    await deleteUploadedImageIfLocal(existing.logoUrl);
  }

  return category;
}

/** Same as updateCategory({ logoUrl }), but the image bytes come from a multipart upload
 * (see categories.routes.ts) instead of an already-hosted url. */
export async function uploadCategoryLogo(prisma: PrismaClient, categoryId: string, actorUserId: string, buffer: Buffer) {
  const existing = await prisma.productCategory.findUnique({ where: { id: categoryId } });
  if (!existing) throw new NotFoundError("Category not found");

  const { url } = await saveUploadedImage("categories", buffer);
  return updateCategory(prisma, categoryId, actorUserId, { logoUrl: url });
}
