import "dotenv/config";
import bcrypt from "bcrypt";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const role = await prisma.role.findUnique({ where: { slug: "management" } });
  if (!role) throw new Error("management role not found — run the seed first");

  const passwordHash = await bcrypt.hash("asd", 12);
  const existing = await prisma.user.findFirst({ where: { email: { in: ["asd", "asd@asd"] } } });
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { email: "asd@asd.com", passwordHash, roleId: role.id },
      })
    : await prisma.user.upsert({
        where: { email: "asd@asd.com" },
        update: { passwordHash, roleId: role.id },
        create: { email: "asd@asd.com", name: "Test Management", roleId: role.id, passwordHash },
      });
  console.log("Created/updated test user:", user.email, user.id);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
