/**
 * Seed the platform super-admin account.
 *
 * Runs standalone (does not touch seller/theme data):
 *
 *   npm run seed:admin
 *
 * Credentials MUST be provided through the ADMIN_EMAIL /
 * ADMIN_PASSWORD environment variables. There are no
 * defaults: the seed fails hard if either is missing, so a
 * known credential can never be provisioned implicitly.
 *
 * The password is never logged or printed.
 */
import "dotenv/config";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const run = async (): Promise<void> => {
  const email = (process.env.ADMIN_EMAIL ?? "")
    .trim()
    .toLowerCase();

  const password = process.env.ADMIN_PASSWORD ?? "";

  if (!email) {
    throw new Error(
      "ADMIN_EMAIL is required. Set a real admin email in the environment before running the admin seed."
    );
  }

  if (!password) {
    throw new Error(
      "ADMIN_PASSWORD is required. Set a strong password in the environment before running the admin seed."
    );
  }

  if (password.length < 8) {
    throw new Error(
      "ADMIN_PASSWORD must be at least 8 characters. Set a strong ADMIN_PASSWORD in the environment."
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const existing = await prisma.adminUser.findUnique({
    where: { email },
  });

  if (existing) {
    await prisma.adminUser.update({
      where: { id: existing.id },
      data: {
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        passwordHash,
      },
    });

    console.log(`Super-admin updated: ${email}`);
    return;
  }

  const admin = await prisma.adminUser.create({
    data: {
      email,
      passwordHash,
      firstName: "Hamim",
      lastName: "Quazi",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    },
  });

  console.log(`Super-admin created: ${admin.email} (id: ${admin.id})`);
};

run()
  .catch((err) => {
    console.error("Admin seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    prisma.$disconnect();
  });
