import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBackfillPlan,
  extractPhoneNumberIds,
  PhoneOwnershipError,
  resolveActiveOwner,
  hasOtherActiveWabaConnection,
} from "./whatsappOwnership.service";

/*
 * Unit tests for the WhatsApp phone-number ownership service.
 *
 * Prisma is NOT available in this environment: the transaction
 * client is mocked. These tests exercise the pure decision logic
 * (extraction, backfill planning, fail-closed owner resolution)
 * against injected fixtures only. They have NOT been executed
 * here — run with `node --test dist/services/whatsappOwnership.service.test.js`
 * after `npx prisma generate && npm run build` in an environment
 * with Node.js available.
 */

/* ----------------------------------------------------
   extractPhoneNumberIds
---------------------------------------------------- */

describe("extractPhoneNumberIds", () => {
  it("extracts ids from metadata.phoneNumberIds", () => {
    const ids = extractPhoneNumberIds({
      phoneNumberIds: ["111", "222"],
    });

    assert.deepEqual(ids, ["111", "222"]);
  });

  it("extracts ids from metadata.phoneNumbers objects", () => {
    const ids = extractPhoneNumberIds({
      phoneNumbers: [
        { id: "333", display_phone_number: "+91..." },
        { phone_number_id: "444" },
      ],
    });

    assert.deepEqual(ids, ["333", "444"]);
  });

  it("merges and dedupes both shapes in order", () => {
    const ids = extractPhoneNumberIds({
      phoneNumberIds: ["111", "333"],
      phoneNumbers: [{ id: "333" }, { id: "555" }],
    });

    assert.deepEqual(ids, ["111", "333", "555"]);
  });

  it("skips malformed entries", () => {
    const ids = extractPhoneNumberIds({
      phoneNumberIds: ["", "   ", 42, null],
      phoneNumbers: [
        null,
        "not-an-object",
        {},
        { id: "777" },
      ],
    });

    assert.deepEqual(ids, ["42", "777"]);
  });

  it("returns empty array for null metadata", () => {
    assert.deepEqual(extractPhoneNumberIds(null), []);
    assert.deepEqual(extractPhoneNumberIds(undefined), []);
  });
});

/* ----------------------------------------------------
   buildBackfillPlan
---------------------------------------------------- */

describe("buildBackfillPlan", () => {
  it("preserves the lowest connection id as canonical owner (current routing owner)", () => {
    const plan = buildBackfillPlan([
      {
        id: 2,
        sellerId: 20,
        wabaId: "WABA",
        metadata: { phoneNumberIds: ["111"] },
      },
      {
        id: 1,
        sellerId: 10,
        wabaId: "WABA",
        metadata: { phoneNumberIds: ["111", "222"] },
      },
    ]);

    // Input order is deliberately reversed; id 1 must win.
    assert.equal(plan.assignments.length, 2);
    assert.equal(
      plan.assignments.find((a) => a.phoneNumberId === "111")
        ?.connectionId,
      1
    );
    assert.equal(
      plan.assignments.find((a) => a.phoneNumberId === "222")
        ?.connectionId,
      1
    );
  });

  it("reports conflicts without deleting or reassigning", () => {
    const plan = buildBackfillPlan([
      {
        id: 1,
        sellerId: 10,
        wabaId: "WABA",
        metadata: { phoneNumberIds: ["111"] },
      },
      {
        id: 2,
        sellerId: 20,
        wabaId: "WABA",
        metadata: { phoneNumberIds: ["111", "222"] },
      },
      {
        id: 3,
        sellerId: 30,
        wabaId: "WABA",
        metadata: { phoneNumberIds: ["111"] },
      },
    ]);

    const conflict = plan.conflicts.find(
      (c) => c.phoneNumberId === "111"
    );

    assert.ok(conflict);
    assert.equal(conflict.canonicalConnectionId, 1);
    assert.deepEqual(conflict.conflictingConnectionIds, [2, 3]);

    // "222" is still assigned to connection 2.
    assert.equal(
      plan.assignments.find((a) => a.phoneNumberId === "222")
        ?.connectionId,
      2
    );
  });

  it("produces an empty plan for connections without phone claims", () => {
    const plan = buildBackfillPlan([
      { id: 1, sellerId: 10, wabaId: null, metadata: {} },
    ]);

    assert.equal(plan.assignments.length, 0);
    assert.equal(plan.conflicts.length, 0);
  });
});

/* ----------------------------------------------------
   resolveActiveOwner — fail-closed resolution
---------------------------------------------------- */

const makeTx = (rows: any[]) =>
  ({
    whatsAppPhoneOwnership: {
      findMany: async () => rows,
    },
    channelConnection: {
      findFirst: async ({ where }: any) =>
        where.id === rows[0]?.connectionId && where.isActive
          ? {
              id: where.id,
              sellerId: rows[0]?.sellerId,
            }
          : null,
    },
  } as any);

describe("resolveActiveOwner", () => {
  it("resolves the single active owner", async () => {
    const tx = makeTx([
      { connectionId: 7, sellerId: 42 },
    ]);

    const owner = await resolveActiveOwner(tx, "111");

    assert.deepEqual(owner, { connectionId: 7, sellerId: 42 });
  });

  it("fails closed with UNKNOWN_PHONE_NUMBER when no active row exists", async () => {
    const tx = makeTx([]);

    await assert.rejects(
      resolveActiveOwner(tx, "111"),
      (error: unknown) =>
        error instanceof PhoneOwnershipError &&
        error.code === "UNKNOWN_PHONE_NUMBER"
    );
  });

  it("fails closed with AMBIGUOUS_PHONE_OWNERSHIP on duplicate active rows", async () => {
    const tx = makeTx([
      { connectionId: 7, sellerId: 42 },
      { connectionId: 8, sellerId: 43 },
    ]);

    await assert.rejects(
      resolveActiveOwner(tx, "111"),
      (error: unknown) =>
        error instanceof PhoneOwnershipError &&
        error.code === "AMBIGUOUS_PHONE_OWNERSHIP"
    );
  });

  it("fails closed with OWNER_CONNECTION_INACTIVE when the owning connection is inactive", async () => {
    const tx = makeTx([{ connectionId: 7, sellerId: 42 }]);
    // The mock's findFirst returns null because isActive is checked.
    tx.channelConnection.findFirst = async () => null;

    await assert.rejects(
      resolveActiveOwner(tx, "111"),
      (error: unknown) =>
        error instanceof PhoneOwnershipError &&
        error.code === "OWNER_CONNECTION_INACTIVE"
    );
  });
});

/* ----------------------------------------------------
   hasOtherActiveWabaConnection
---------------------------------------------------- */

describe("hasOtherActiveWabaConnection", () => {
  const makeTx = (count: number) =>
    ({
      channelConnection: {
        count: async () => count,
      },
    } as any);

  it("returns true when another active connection shares the WABA", async () => {
    assert.equal(
      await hasOtherActiveWabaConnection(makeTx(1), "WABA", 7),
      true
    );
  });

  it("returns false when this is the only active connection for the WABA", async () => {
    assert.equal(
      await hasOtherActiveWabaConnection(makeTx(0), "WABA", 7),
      false
    );
  });
});
