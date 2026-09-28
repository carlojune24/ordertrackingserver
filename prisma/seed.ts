import "dotenv/config";
import bcrypt from "bcrypt";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const DEV_PASSWORD = "DevPass123!";

const PERMISSION_DEFS = [
  { slug: "users.manage", name: "Manage users" },
  { slug: "roles.manage", name: "Manage roles & permissions" },
  { slug: "activity.view", name: "View activity log" },
  { slug: "categories.manage", name: "Manage product categories" },
  { slug: "products.manage", name: "Manage products" },
  { slug: "products.price_history.view", name: "View product price history" },
  { slug: "promos.manage", name: "Manage promo codes" },
  { slug: "stations.manage", name: "Manage stations" },
  { slug: "qc_rejection_reasons.manage", name: "Manage QC rejection reasons" },
  { slug: "orders.create", name: "Create orders (intake)" },
  { slug: "orders.edit", name: "Edit orders" },
  { slug: "orders.archive", name: "Archive/unarchive orders" },
  { slug: "orders.qr.regenerate", name: "Regenerate order QR code" },
  { slug: "orders.report.view", name: "View order turnaround reports" },
  { slug: "orders.override_station", name: "Override order station/worker assignment" },
  { slug: "scan.perform", name: "Perform station scan-in/out" },
  { slug: "qc.decide", name: "Record QC decisions" },
  { slug: "delivery.record", name: "Record delivery outcomes" },
  { slug: "return.decide", name: "Record Return station decisions" },
  { slug: "orders.replacement.issue", name: "Issue order replacements" },
  { slug: "qc.view_only", name: "View QC page only" },
  { slug: "delivery.view_only", name: "View delivery page only" },
] as const;

const ALL_PERMISSION_SLUGS = PERMISSION_DEFS.map((p) => p.slug);

const ROLE_DEFS = [
  { name: "Management", slug: "management", permissionSlugs: ALL_PERMISSION_SLUGS },
  {
    name: "Supervisor",
    slug: "supervisor",
    permissionSlugs: [
      "orders.create",
      "orders.edit",
      "orders.archive",
      "orders.qr.regenerate",
      "orders.report.view",
      "products.price_history.view",
      "scan.perform",
      "qc.decide",
      "delivery.record",
      "return.decide",
      "orders.replacement.issue",
    ],
  },
  {
    name: "Production Staff",
    slug: "production-staff",
    permissionSlugs: ["orders.create", "scan.perform", "qc.decide", "delivery.record", "return.decide"],
  },
  {
    name: "Station Worker",
    slug: "station-worker",
    permissionSlugs: ["scan.perform"],
  },
] as const;

const CATEGORY_NAMES = [
  "Ford",
  "Honda",
  "Hyundai",
  "Isuzu",
  "Kia",
  "Mazda",
  "Mitsubishi",
  "Nissan",
  "Suzuki",
  "Toyota",
];

// Dynamic, Management-editable production stations — a Station Worker gets assigned to
// one of these. Order is just the seed default; Management can reorder freely.
const STATION_DEFS = [
  { name: "Cutting", isQcCheckpoint: false },
  { name: "Sewing", isQcCheckpoint: false },
  { name: "Embroidery", isQcCheckpoint: false },
];

// Fixed, code-defined stages every order passes through after its dynamic stations —
// isSystem: true, so stations.service.ts rejects any PATCH and workflow.ts always sorts
// them last (in THIS order, by sortOrder). QC still exits via a decision, not a plain
// outgoing scan (isQcCheckpoint). Packaging sits between QC and Courier/Pick-up — a
// regular receive/outgoing punch like any dynamic station, but fixed in position and,
// being isSystem, can never issue a rework/reject back to QC or any earlier station
// (see workflow.ts canReturnForRework) — its only exit is forward into delivery.
// "Return" is also a fixed system station but sits OFF that sequence (isReturnStation, skipped
// by workflow.ts) — delivery's RETURNED outcome sends orders here, and its decision routes
// them to QC or flags items for replacement.
const SYSTEM_STATION_DEFS = [
  { name: "QC", isQcCheckpoint: true, isReturnStation: false },
  { name: "Packaging", isQcCheckpoint: false, isReturnStation: false },
  { name: "Courier / Pick-up", isQcCheckpoint: false, isReturnStation: false },
  { name: "Return", isQcCheckpoint: false, isReturnStation: true },
];

async function upsertUser(email: string, name: string, roleId: string, assignedStationId?: string) {
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 12);
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name, roleId, assignedStationId, passwordHash },
  });
}

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main() {
  const permissionBySlug = new Map<string, string>();
  for (const def of PERMISSION_DEFS) {
    const permission = await prisma.permission.upsert({
      where: { slug: def.slug },
      update: { name: def.name },
      create: { slug: def.slug, name: def.name },
    });
    permissionBySlug.set(def.slug, permission.id);
  }

  const roleBySlug = new Map<string, string>();
  for (const def of ROLE_DEFS) {
    const role = await prisma.role.upsert({
      where: { slug: def.slug },
      update: { name: def.name },
      create: { name: def.name, slug: def.slug },
    });
    roleBySlug.set(def.slug, role.id);

    // Replace the role's permission set each run so reseeding self-heals any drift.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: def.permissionSlugs.map((slug) => ({
        roleId: role.id,
        permissionId: permissionBySlug.get(slug)!,
      })),
    });
  }

  const categories = new Map<string, string>();
  for (const [index, name] of CATEGORY_NAMES.entries()) {
    const category = await prisma.productCategory.upsert({
      where: { slug: slugify(name) },
      update: {},
      create: { name, slug: slugify(name), sortOrder: index },
    });
    categories.set(name, category.id);
  }

  let firstStationId: string | undefined;
  for (const [index, def] of STATION_DEFS.entries()) {
    const station = await prisma.station.upsert({
      where: { slug: slugify(def.name) },
      // Management owns sortOrder/isActive after creation — don't stomp those on reseed,
      // just guard against isSystem drift (this list is the source of truth for "dynamic").
      update: { isSystem: false },
      create: { name: def.name, slug: slugify(def.name), sortOrder: index, isQcCheckpoint: def.isQcCheckpoint },
    });
    if (index === 0) firstStationId = station.id;
  }

  for (const [index, def] of SYSTEM_STATION_DEFS.entries()) {
    await prisma.station.upsert({
      where: { slug: slugify(def.name) },
      // Fully seed-controlled (Management can't PATCH a system station), so self-heal every
      // field on reseed — covers rows that pre-date isSystem and were never marked true.
      update: { sortOrder: index, isQcCheckpoint: def.isQcCheckpoint, isReturnStation: def.isReturnStation, isSystem: true },
      create: {
        name: def.name,
        slug: slugify(def.name),
        sortOrder: index,
        isQcCheckpoint: def.isQcCheckpoint,
        isReturnStation: def.isReturnStation,
        isSystem: true,
      },
    });
  }

  // Real-looking names, not job-title placeholders — the role is already shown separately
  // wherever an actor appears (e.g. timeline entries render "name (roleName)"), so a name
  // that duplicates the role text (the old "Production Staff" / "Plant Manager" placeholders)
  // made it look like the app couldn't tell users apart. It always could; the seed data just
  // didn't demonstrate it with only one user per role.
  const staff = await upsertUser("staff@rascorp.test", "Juan Dela Cruz", roleBySlug.get("production-staff")!);
  await upsertUser("supervisor@rascorp.test", "Maria Santos", roleBySlug.get("supervisor")!);
  await upsertUser("management@rascorp.test", "Roberto Reyes", roleBySlug.get("management")!);
  await upsertUser("stationworker@rascorp.test", "Ana Bautista", roleBySlug.get("station-worker")!, firstStationId);

  // Sample product + demo order are dev/staging fixtures only — production gets real
  // categories and stations to work with, but Management adds real products via the API.
  if (process.env.NODE_ENV !== "production") {
    let demoProduct = await prisma.product.findFirst({ where: { name: { startsWith: "DashProtec" } } });
    if (!demoProduct) {
      demoProduct = await prisma.product.create({
        data: {
          categoryId: categories.get("Toyota")!,
          name: "DashProtec™ Backboard Cover for Toyota Vios 3rd and 4th Gen 2013-2021| NonSlip 3 Layer Materials with Heat Insulation",
          description: "Non-slip 3-layer dash cover with heat insulation.",
          regularPrice: 1999,
          customizedPrice: 2499,
          rating: 5,
          images: {
            create: [
              { url: "https://placehold.co/600x400?text=DashProtec+1", sortOrder: 0, isPrimary: true },
              { url: "https://placehold.co/600x400?text=DashProtec+2", sortOrder: 1, isPrimary: false },
            ],
          },
          colorLinings: {
            create: [
              { label: "Black Lining", sortOrder: 0 },
              { label: "Red Lining", sortOrder: 1 },
            ],
          },
        },
        include: { colorLinings: true },
      });
      await prisma.productPriceHistory.create({
        data: {
          productId: demoProduct.id,
          regularPrice: demoProduct.regularPrice,
          customizedPrice: demoProduct.customizedPrice,
          changedByUserId: staff.id,
        },
      });
    }

    const existingDemo = await prisma.order.findUnique({ where: { orderNumber: "RC-DEMO-000001" } });
    if (!existingDemo) {
      const blackLining = await prisma.productColorLining.findFirst({
        where: { productId: demoProduct.id, label: "Black Lining" },
      });
      const demoCustomer = await prisma.customer.upsert({
        where: { email: "demo.customer@rascorp.test" },
        update: {},
        create: { name: "Demo Customer", email: "demo.customer@rascorp.test" },
      });

      await prisma.order.create({
        data: {
          orderNumber: "RC-DEMO-000001",
          customerId: demoCustomer.id,
          proposedDurationDays: 5,
          deadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
          priority: 1,
          currentStationId: firstStationId,
          createdByUserId: staff.id,
          items: {
            create: [
              {
                itemNo: 1,
                productId: demoProduct.id,
                colorLiningId: blackLining?.id,
                unitPrice: demoProduct.regularPrice,
                regularPriceAtOrder: demoProduct.regularPrice,
              },
            ],
          },
        },
      });
    }
  }

  console.log("Seed complete. Dev users (password for all: %s):", DEV_PASSWORD);
  console.log("  staff@rascorp.test / supervisor@rascorp.test / management@rascorp.test / stationworker@rascorp.test");
  console.log(
    "Seeded %d permissions, %d roles, %d categories, %d dynamic stations, and %d system stages.",
    PERMISSION_DEFS.length,
    ROLE_DEFS.length,
    CATEGORY_NAMES.length,
    STATION_DEFS.length,
    SYSTEM_STATION_DEFS.length,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
