import "dotenv/config";

import prisma from "../src/prisma/client";
import {
  decrypt,
  encrypt,
} from "../src/services/crypto.service";

const isGcm = (value: string): boolean =>
  value.startsWith("gcm:v1:");

const migrateField = (
  value: string | null | undefined
): string | null | undefined => {
  if (!value || isGcm(value)) {
    return value;
  }

  const plaintext = decrypt(value);

  return encrypt(plaintext);
};

const main = async () => {
  let sellerCount = 0;
  let channelCount = 0;

  const sellers = await prisma.seller.findMany({
    where: {
      gatewayKeySecret: {
        not: null,
      },
    },
    select: {
      id: true,
      gatewayKeySecret: true,
    },
  });

  for (const seller of sellers) {
    if (!seller.gatewayKeySecret) {
      continue;
    }

    if (isGcm(seller.gatewayKeySecret)) {
      continue;
    }

    const migrated = migrateField(
      seller.gatewayKeySecret
    );

    await prisma.seller.update({
      where: {
        id: seller.id,
      },
      data: {
        gatewayKeySecret: migrated,
      },
    });

    sellerCount++;
  }

  const channels =
    await prisma.channelConnection.findMany({
      where: {
        accessToken: {
          not: null,
        },
      },
      select: {
        id: true,
        accessToken: true,
      },
    });

  for (const channel of channels) {
    if (!channel.accessToken) {
      continue;
    }

    if (isGcm(channel.accessToken)) {
      continue;
    }

    const migrated = migrateField(
      channel.accessToken
    );

    await prisma.channelConnection.update({
      where: {
        id: channel.id,
      },
      data: {
        accessToken: migrated,
      },
    });

    channelCount++;
  }

  console.log(
    `Encryption migration complete. Sellers migrated: ${sellerCount}. Channels migrated: ${channelCount}.`
  );
};

main()
  .catch((error) => {
    console.error(
      "Encryption migration failed:",
      error instanceof Error
        ? error.message
        : "Unknown error"
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });