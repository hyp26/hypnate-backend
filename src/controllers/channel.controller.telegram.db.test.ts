import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * Database-backed tests for Telegram connection lifecycle.
 * TEST_DATABASE_URL must point only to the disposable local PostgreSQL DB.
 * Telegram HTTP calls are stubbed; no real bot token or Telegram API request
 * is used.
 */
const DB_URL = process.env.TEST_DATABASE_URL;

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
}

/* eslint-disable @typescript-eslint/no-var-requires */
const controller = DB_URL ? require("./channel.controller") : null;
const prisma = DB_URL ? require("../prisma/client").default : null;
const axiosModule = DB_URL ? require("axios") : null;
const axios = axiosModule?.default ?? axiosModule;
const cryptoService = DB_URL
  ? require("../services/crypto.service")
  : null;
/* eslint-enable @typescript-eslint/no-var-requires */

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let sellerSequence = 0;

async function createSeller() {
  sellerSequence += 1;
  return prisma.seller.create({
    data: {
      businessName: `telegram-connect-test-${RUN}-${sellerSequence}`,
    },
  });
}

async function cleanupSeller(sellerId: number) {
  await prisma.channelConnection.deleteMany({ where: { sellerId } });
  await prisma.seller.deleteMany({ where: { id: sellerId } });
}

function makeRequest(sellerId: number, botToken: string) {
  return {
    user: { sellerId },
    body: { botToken },
  } as any;
}

function makeResponse() {
  const response: any = { statusCode: 200, body: null };
  response.status = (code: number) => {
    response.statusCode = code;
    return response;
  };
  response.json = (body: unknown) => {
    response.body = body;
    return response;
  };
  return response;
}

type TelegramMockOptions = {
  webhookOk?: boolean;
  getMeOk?: boolean;
  postError?: Error;
  beforeGet?: () => void;
  beforePost?: (url: string, body: any) => Promise<void>;
};

function mockTelegramApi(
  defaultBotId: number,
  options: TelegramMockOptions = {}
) {
  const originalGet = axios.get;
  const originalPost = axios.post;
  const webhookCalls: Array<{ url: string; body: any }> = [];

  axios.get = async (url: string) => {
    options.beforeGet?.();
    const tokenBotId = Number(/\/bot(\d+):/.exec(url)?.[1]);
    const botId =
      Number.isSafeInteger(tokenBotId) && tokenBotId > 0
        ? tokenBotId
        : defaultBotId;

    return {
      data: options.getMeOk === false
        ? { ok: false }
        : {
            ok: true,
            result: {
              id: botId,
              first_name: "Test Bot",
              username: "hypnate_test_bot",
            },
          },
    };
  };

  axios.post = async (url: string, body: any) => {
    webhookCalls.push({ url, body });

    if (options.beforePost) {
      await options.beforePost(url, body);
    }

    if (options.postError) {
      throw options.postError;
    }

    return {
      data: { ok: options.webhookOk !== false },
    };
  };

  return {
    webhookCalls,
    options,
    restore() {
      axios.get = originalGet;
      axios.post = originalPost;
    },
  };
}

const dbTest = (name: string, fn: () => Promise<void>) =>
  test(
    name,
    {
      skip: DB_URL
        ? false
        : "TEST_DATABASE_URL not set — database test skipped (not run, not passed)",
    },
    fn
  );

dbTest(
  "first Telegram connection activates one identity and leaves WhatsApp untouched",
  async () => {
    const seller = await createSeller();
    const whatsapp = await prisma.channelConnection.create({
      data: {
        sellerId: seller.id,
        platform: "WHATSAPP",
        accessToken: "whatsapp-token-sentinel",
        isActive: true,
      },
    });
    const api = mockTelegramApi(123456);

    try {
      const response = makeResponse();
      await controller.connectTelegram(
        makeRequest(seller.id, "123456:test-token"),
        response
      );

      assert.equal(response.statusCode, 200);

      const telegramRows = await prisma.channelConnection.findMany({
        where: { sellerId: seller.id, platform: "TELEGRAM" },
      });

      assert.equal(telegramRows.length, 1);
      assert.equal(telegramRows[0].isActive, true);
      assert.equal(telegramRows[0].externalAccountId, "123456");
      assert.equal(
        cryptoService.decrypt(telegramRows[0].accessToken ?? ""),
        "123456:test-token"
      );
      assert.equal(api.webhookCalls.length, 1);
      assert.equal(
        api.webhookCalls[0].body.secret_token,
        cryptoService.decrypt(telegramRows[0].webhookSecret)
      );

      const unchangedWhatsApp =
        await prisma.channelConnection.findUnique({
          where: { id: whatsapp.id },
        });

      assert.equal(unchangedWhatsApp?.id, whatsapp.id);
      assert.equal(
        unchangedWhatsApp?.accessToken,
        "whatsapp-token-sentinel"
      );
      assert.equal(unchangedWhatsApp?.isActive, true);
    } finally {
      api.restore();
      await cleanupSeller(seller.id);
    }
  }
);

dbTest(
  "same-bot token rotation preserves connection ID and webhook secret",
  async () => {
    const seller = await createSeller();
    const originalSecret = "existing-telegram-webhook-secret";
    const existing = await prisma.channelConnection.create({
      data: {
        sellerId: seller.id,
        platform: "TELEGRAM",
        accessToken: cryptoService.encrypt("123456:old-token"),
        webhookSecret: cryptoService.encrypt(originalSecret),
        webhookUrl: "https://example.test/api/webhooks/telegram/old",
        isActive: true,
        externalAccountId: null,
      },
    });
    const api = mockTelegramApi(123456);

    try {
      const response = makeResponse();
      await controller.connectTelegram(
        makeRequest(seller.id, "123456:rotated-token"),
        response
      );

      assert.equal(response.statusCode, 200);

      const updated = await prisma.channelConnection.findUnique({
        where: { id: existing.id },
      });

      assert.equal(updated?.id, existing.id);
      assert.equal(updated?.externalAccountId, "123456");
      assert.equal(
        cryptoService.decrypt(updated?.accessToken ?? ""),
        "123456:rotated-token"
      );
      assert.equal(
        cryptoService.decrypt(updated?.webhookSecret ?? ""),
        originalSecret
      );
      assert.equal(updated?.isActive, true);
      assert.equal(api.webhookCalls.length, 1);
      assert.equal(api.webhookCalls[0].body.secret_token, originalSecret);
    } finally {
      api.restore();
      await cleanupSeller(seller.id);
    }
  }
);

dbTest(
  "concurrent same-bot token rotations serialize webhook registration and stored credentials",
  async () => {
    const seller = await createSeller();
    const originalSecret = "concurrent-rotation-stable-secret";
    const existing = await prisma.channelConnection.create({
      data: {
        sellerId: seller.id,
        platform: "TELEGRAM",
        accessToken: cryptoService.encrypt("123456:initial-token"),
        webhookSecret: cryptoService.encrypt(originalSecret),
        externalAccountId: "123456",
        isActive: true,
      },
    });

    let getMeCalls = 0;
    let postCalls = 0;
    let signalSecondGetMe!: () => void;
    let signalFirstPost!: () => void;
    let releaseFirstPost!: () => void;

    const secondGetMeReached = new Promise<void>((resolve) => {
      signalSecondGetMe = resolve;
    });
    const firstPostStarted = new Promise<void>((resolve) => {
      signalFirstPost = resolve;
    });
    const firstPostGate = new Promise<void>((resolve) => {
      releaseFirstPost = resolve;
    });

    const api = mockTelegramApi(123456, {
      beforeGet: () => {
        getMeCalls += 1;
        if (getMeCalls === 2) signalSecondGetMe();
      },
      beforePost: async () => {
        postCalls += 1;
        if (postCalls === 1) {
          signalFirstPost();
          await firstPostGate;
        }
      },
    });
    const pendingRequests: Promise<unknown>[] = [];

    try {
      const firstResponse = makeResponse();
      const firstRequest = controller.connectTelegram(
        makeRequest(seller.id, "123456:first-rotated-token"),
        firstResponse
      );
      pendingRequests.push(firstRequest);

      // Hold the first request inside setWebhook while the second request
      // verifies its token and attempts to enter the seller's lifecycle.
      await firstPostStarted;

      const secondResponse = makeResponse();
      const secondRequest = controller.connectTelegram(
        makeRequest(seller.id, "123456:second-rotated-token"),
        secondResponse
      );
      pendingRequests.push(secondRequest);

      await secondGetMeReached;
      // Allow the second request to reach the serialized lifecycle before
      // asserting that it has not started a second Telegram API call.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        api.webhookCalls.length,
        1,
        "the second webhook request must wait for the first lifecycle"
      );

      releaseFirstPost();
      await Promise.all([firstRequest, secondRequest]);

      assert.equal(firstResponse.statusCode, 200);
      assert.equal(secondResponse.statusCode, 200);
      assert.equal(api.webhookCalls.length, 2);
      assert.match(api.webhookCalls[0].url, /first-rotated-token/);
      assert.match(api.webhookCalls[1].url, /second-rotated-token/);
      assert.equal(
        api.webhookCalls[0].body.secret_token,
        originalSecret
      );
      assert.equal(
        api.webhookCalls[1].body.secret_token,
        originalSecret
      );

      const updated = await prisma.channelConnection.findUnique({
        where: { id: existing.id },
      });

      assert.equal(updated?.id, existing.id);
      assert.equal(
        cryptoService.decrypt(updated?.accessToken ?? ""),
        "123456:second-rotated-token"
      );
      assert.equal(
        cryptoService.decrypt(updated?.webhookSecret ?? ""),
        originalSecret
      );
      assert.equal(updated?.isActive, true);
    } finally {
      // Prevent a failed assertion from leaving the first request blocked.
      releaseFirstPost();
      if (pendingRequests.length > 0) {
        await Promise.allSettled(pendingRequests);
      }
      api.restore();
      await cleanupSeller(seller.id);
    }
  }
);

dbTest(
  "Telegram connection waits for a PostgreSQL advisory lock held by another session",
  async () => {
    const seller = await createSeller();
    let signalLockAcquired!: () => void;
    let releaseLock!: () => void;
    let signalGetMe!: () => void;

    const lockAcquired = new Promise<void>((resolve) => {
      signalLockAcquired = resolve;
    });
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const getMeReached = new Promise<void>((resolve) => {
      signalGetMe = resolve;
    });

    const api = mockTelegramApi(123456, {
      beforeGet: signalGetMe,
    });

    let connectRequest: Promise<unknown> | undefined;
    let externalLock: Promise<unknown> | undefined;

    try {
      externalLock = prisma.$transaction(
        async (tx: any) => {
          await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(
              CAST(${0x54474c} AS INTEGER),
              CAST(${seller.id} AS INTEGER)
            )
          `;
          signalLockAcquired();
          await lockGate;
        },
        { maxWait: 10_000, timeout: 30_000 }
      );

      await lockAcquired;

      const response = makeResponse();
      connectRequest = controller.connectTelegram(
        makeRequest(seller.id, "123456:cross-instance-token"),
        response
      );

      await getMeReached;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        api.webhookCalls.length,
        0,
        "setWebhook must not run until the PostgreSQL advisory lock is released"
      );

      releaseLock();
      await externalLock;
      await connectRequest;

      assert.equal(response.statusCode, 200);
      assert.equal(api.webhookCalls.length, 1);

      const saved = await prisma.channelConnection.findFirst({
        where: { sellerId: seller.id, platform: "TELEGRAM" },
      });
      assert.equal(saved?.isActive, true);
      assert.equal(
        cryptoService.decrypt(saved?.accessToken ?? ""),
        "123456:cross-instance-token"
      );
    } finally {
      releaseLock();
      const pending = [externalLock, connectRequest].filter(
        (promise): promise is Promise<unknown> => Boolean(promise)
      );
      if (pending.length > 0) await Promise.allSettled(pending);
      api.restore();
      await cleanupSeller(seller.id);
    }
  }
);

dbTest(
  "different Telegram bot identity is rejected without changing the connection",
  async () => {
    const seller = await createSeller();
    const existing = await prisma.channelConnection.create({
      data: {
        sellerId: seller.id,
        platform: "TELEGRAM",
        accessToken: cryptoService.encrypt("123456:old-token"),
        webhookSecret: cryptoService.encrypt("stable-secret"),
        externalAccountId: "123456",
        isActive: true,
      },
    });
    const api = mockTelegramApi(654321);

    try {
      const response = makeResponse();
      await controller.connectTelegram(
        makeRequest(seller.id, "654321:other-bot-token"),
        response
      );

      assert.equal(response.statusCode, 409);
      assert.equal(api.webhookCalls.length, 0);

      const unchanged = await prisma.channelConnection.findUnique({
        where: { id: existing.id },
      });

      assert.equal(unchanged?.id, existing.id);
      assert.equal(
        cryptoService.decrypt(unchanged?.accessToken ?? ""),
        "123456:old-token"
      );
      assert.equal(
        cryptoService.decrypt(unchanged?.webhookSecret ?? ""),
        "stable-secret"
      );
    } finally {
      api.restore();
      await cleanupSeller(seller.id);
    }
  }
);

dbTest(
  "legacy connection without webhook secret persists a new secret before registration",
  async () => {
    const seller = await createSeller();
    const existing = await prisma.channelConnection.create({
      data: {
        sellerId: seller.id,
        platform: "TELEGRAM",
        accessToken: cryptoService.encrypt("123456:old-token"),
        webhookSecret: null,
        externalAccountId: null,
        isActive: true,
      },
    });

    const api = mockTelegramApi(123456, {
      beforePost: async (_url, body) => {
        const row = await prisma.channelConnection.findUnique({
          where: { id: existing.id },
        });

        assert.ok(row?.webhookSecret);
        assert.equal(row?.isActive, false);
        assert.equal(
          cryptoService.decrypt(row?.accessToken ?? ""),
          "123456:new-token"
        );
        assert.equal(
          cryptoService.decrypt(row?.webhookSecret ?? ""),
          body.secret_token
        );
      },
    });

    try {
      const response = makeResponse();
      await controller.connectTelegram(
        makeRequest(seller.id, "123456:new-token"),
        response
      );

      assert.equal(response.statusCode, 200);

      const updated = await prisma.channelConnection.findUnique({
        where: { id: existing.id },
      });

      assert.equal(updated?.id, existing.id);
      assert.equal(updated?.isActive, true);
      assert.ok(updated?.webhookSecret);
      assert.equal(api.webhookCalls.length, 1);
    } finally {
      api.restore();
      await cleanupSeller(seller.id);
    }
  }
);

dbTest(
  "failed first-time webhook registration retains an inactive retryable reservation",
  async () => {
    const seller = await createSeller();
    const api = mockTelegramApi(123456, { webhookOk: false });

    try {
      const firstResponse = makeResponse();
      await controller.connectTelegram(
        makeRequest(seller.id, "123456:test-token"),
        firstResponse
      );

      assert.equal(firstResponse.statusCode, 502);

      const reservation = await prisma.channelConnection.findFirst({
        where: { sellerId: seller.id, platform: "TELEGRAM" },
      });

      assert.ok(reservation);
      assert.equal(reservation?.isActive, false);
      assert.ok(reservation?.webhookSecret);

      api.options.webhookOk = true;

      const retryResponse = makeResponse();
      await controller.connectTelegram(
        makeRequest(seller.id, "123456:test-token"),
        retryResponse
      );

      assert.equal(retryResponse.statusCode, 200);

      const recovered = await prisma.channelConnection.findFirst({
        where: { sellerId: seller.id, platform: "TELEGRAM" },
      });

      assert.equal(recovered?.id, reservation?.id);
      assert.equal(recovered?.isActive, true);
      assert.equal(
        recovered?.webhookSecret,
        reservation?.webhookSecret
      );
      assert.equal(api.webhookCalls.length, 2);
    } finally {
      api.restore();
      await cleanupSeller(seller.id);
    }
  }
);

dbTest(
  "thrown Telegram network error retains an inactive reservation for retry",
  async () => {
    const seller = await createSeller();
    const api = mockTelegramApi(123456, {
      postError: new Error("simulated network timeout"),
    });

    try {
      const firstResponse = makeResponse();
      await controller.connectTelegram(
        makeRequest(seller.id, "123456:test-token"),
        firstResponse
      );

      assert.equal(firstResponse.statusCode, 502);

      const reservation = await prisma.channelConnection.findFirst({
        where: { sellerId: seller.id, platform: "TELEGRAM" },
      });

      assert.ok(reservation);
      assert.equal(reservation?.isActive, false);

      api.options.postError = undefined;

      const retryResponse = makeResponse();
      await controller.connectTelegram(
        makeRequest(seller.id, "123456:test-token"),
        retryResponse
      );

      assert.equal(retryResponse.statusCode, 200);

      const recovered = await prisma.channelConnection.findUnique({
        where: { id: reservation?.id },
      });

      assert.equal(recovered?.isActive, true);
      assert.equal(api.webhookCalls.length, 2);
    } finally {
      api.restore();
      await cleanupSeller(seller.id);
    }
  }
);

dbTest(
  "invalid bot-token verification does not modify an existing connection",
  async () => {
    const seller = await createSeller();
    const existing = await prisma.channelConnection.create({
      data: {
        sellerId: seller.id,
        platform: "TELEGRAM",
        accessToken: cryptoService.encrypt("123456:old-token"),
        webhookSecret: cryptoService.encrypt("stable-secret"),
        externalAccountId: "123456",
        isActive: true,
      },
    });
    const api = mockTelegramApi(123456, { getMeOk: false });

    try {
      const response = makeResponse();
      await controller.connectTelegram(
        makeRequest(seller.id, "123456:invalid-token"),
        response
      );

      assert.equal(response.statusCode, 400);
      assert.equal(api.webhookCalls.length, 0);

      const unchanged = await prisma.channelConnection.findUnique({
        where: { id: existing.id },
      });

      assert.equal(unchanged?.id, existing.id);
      assert.equal(
        cryptoService.decrypt(unchanged?.accessToken ?? ""),
        "123456:old-token"
      );
    } finally {
      api.restore();
      await cleanupSeller(seller.id);
    }
  }
);

dbTest(
  "database credential update failure does not call Telegram or alter the existing row",
  async () => {
    const seller = await createSeller();
    const originalSecret = "stable-secret";
    const existing = await prisma.channelConnection.create({
      data: {
        sellerId: seller.id,
        platform: "TELEGRAM",
        accessToken: cryptoService.encrypt("123456:old-token"),
        webhookSecret: cryptoService.encrypt(originalSecret),
        externalAccountId: "123456",
        isActive: true,
      },
    });
    const api = mockTelegramApi(123456);
    const originalUpdate = prisma.channelConnection.update;

    try {
      (prisma.channelConnection as any).update = async () => {
        throw new Error("simulated database update failure");
      };

      const response = makeResponse();
      await controller.connectTelegram(
        makeRequest(seller.id, "123456:rotated-token"),
        response
      );

      assert.equal(response.statusCode, 500);
      assert.equal(api.webhookCalls.length, 0);

      const unchanged = await prisma.channelConnection.findUnique({
        where: { id: existing.id },
      });

      assert.equal(unchanged?.id, existing.id);
      assert.equal(
        cryptoService.decrypt(unchanged?.accessToken ?? ""),
        "123456:old-token"
      );
      assert.equal(
        cryptoService.decrypt(unchanged?.webhookSecret ?? ""),
        originalSecret
      );
    } finally {
      (prisma.channelConnection as any).update = originalUpdate;
      api.restore();
      await cleanupSeller(seller.id);
    }
  }
);

dbTest(
  "activation database failure leaves a retryable inactive connection",
  async () => {
    const seller = await createSeller();
    const api = mockTelegramApi(123456);
    const originalUpdate = prisma.channelConnection.update;

    try {
      (prisma.channelConnection as any).update = async (args: any) => {
        if (args?.data?.isActive === true) {
          throw new Error("simulated activation database failure");
        }
        return originalUpdate.call(prisma.channelConnection, args);
      };

      const firstResponse = makeResponse();
      await controller.connectTelegram(
        makeRequest(seller.id, "123456:test-token"),
        firstResponse
      );

      assert.equal(firstResponse.statusCode, 500);
      assert.equal(api.webhookCalls.length, 1);

      const reservation = await prisma.channelConnection.findFirst({
        where: { sellerId: seller.id, platform: "TELEGRAM" },
      });

      assert.ok(reservation);
      assert.equal(reservation?.isActive, false);

      (prisma.channelConnection as any).update = originalUpdate;

      const retryResponse = makeResponse();
      await controller.connectTelegram(
        makeRequest(seller.id, "123456:test-token"),
        retryResponse
      );

      assert.equal(retryResponse.statusCode, 200);

      const recovered = await prisma.channelConnection.findUnique({
        where: { id: reservation?.id },
      });

      assert.equal(recovered?.id, reservation?.id);
      assert.equal(recovered?.isActive, true);
      assert.equal(api.webhookCalls.length, 2);
    } finally {
      (prisma.channelConnection as any).update = originalUpdate;
      api.restore();
      await cleanupSeller(seller.id);
    }
  }
);

dbTest(
  "concurrent first-time attempts for different bots create only one identity",
  async () => {
    const seller = await createSeller();
    const api = mockTelegramApi(123456);

    try {
      const firstResponse = makeResponse();
      const secondResponse = makeResponse();

      await Promise.all([
        controller.connectTelegram(
          makeRequest(seller.id, "123456:first-token"),
          firstResponse
        ),
        controller.connectTelegram(
          makeRequest(seller.id, "654321:second-token"),
          secondResponse
        ),
      ]);

      const rows = await prisma.channelConnection.findMany({
        where: { sellerId: seller.id, platform: "TELEGRAM" },
      });

      assert.equal(rows.length, 1);
      assert.ok([200, 409].includes(firstResponse.statusCode));
      assert.ok([200, 409].includes(secondResponse.statusCode));
      assert.equal(
        [firstResponse.statusCode, secondResponse.statusCode].filter(
          (status) => status === 200
        ).length,
        1
      );
      assert.equal(
        [firstResponse.statusCode, secondResponse.statusCode].filter(
          (status) => status === 409
        ).length,
        1
      );
      assert.equal(api.webhookCalls.length, 1);
    } finally {
      api.restore();
      await cleanupSeller(seller.id);
    }
  }
);
