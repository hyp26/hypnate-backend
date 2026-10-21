import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBackfillPlan,
  extractPhoneNumberIds,
  PhoneOwnershipError,
  resolveActiveOwner,
  hasOtherActiveWabaConnection,
  syncConnectionOwnership,
  assertOwnedPhoneNumberForSend,
} from "./whatsappOwnership.service";

/*
 * Unit tests for the WhatsApp phone-number ownership service.
 *
 * Prisma is NOT available in this environment: the transaction
 * client is mocked. These tests exercise the pure decision logic
 * (extraction, backfill planning, fail-closed owner resolution,
 * conflict-rejecting ownership sync, send guard) against
 * injected fixtures only. They have NOT been executed
 * here — run with `node --test dist/services/whatsappOwnership.service.test.js`
 * after `npx prisma generate && npm run build` in an environment
 * with Node.js available.
 *
 * Database-backed invariant tests (cross-seller conflict, atomic
 * rollback, concurrent claims) live in
 * whatsappOwnership.db.test.ts and REQUIRE a disposable
 * PostgreSQL database.
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

/* ----------------------------------------------------
   syncConnectionOwnership — conflict-rejecting sync
   (audit finding H-3)
---------------------------------------------------- */

type OwnershipRow = {
  id: number;
  phoneNumberId: string;
  connectionId: number;
  sellerId: number;
  wabaId: string | null;
  isActive: boolean;
};

type ConnectionRow = {
  id: number;
  sellerId: number;
  platform: "WHATSAPP";
  isActive: boolean;
};

/*
 * Stateful Prisma-transaction mock: emulates the ownership table
 * (including the partial unique index's observable behaviour via
 * active-row reads), records every write call and every advisory
 * lock acquisition, so tests can assert both WHAT was written and
 * the lock ordering.
 */
const makeOwnershipTx = (
  ownershipRows: OwnershipRow[],
  connectionRows: ConnectionRow[]
) => {
  const rows = ownershipRows.map((row) => ({ ...row }));
  const locks: string[] = [];
  const writeCalls: Array<{
    op: "update" | "updateMany" | "create";
    where?: any;
    data: any;
  }> = [];

  let nextId =
    rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;

  const matchesActive = (row: OwnershipRow, where: any) => {
    if (!row.isActive) {
      return false;
    }

    if ("connectionId" in where && row.connectionId !== where.connectionId) {
      return false;
    }

    if ("phoneNumberId" in where) {
      if (typeof where.phoneNumberId === "string") {
        if (row.phoneNumberId !== where.phoneNumberId) {
          return false;
        }
      } else if (
        where.phoneNumberId &&
        Array.isArray(where.phoneNumberId.in)
      ) {
        if (!where.phoneNumberId.in.includes(row.phoneNumberId)) {
          return false;
        }
      }
    }

    return true;
  };

  const tx: any = {
    $queryRaw: (_strings: TemplateStringsArray, ...values: unknown[]) => {
      locks.push(String(values[0]));
    },
    channelConnection: {
      findFirst: async ({ where }: any) => {
        const connection = connectionRows.find(
          (row) =>
            row.id === where.id &&
            row.platform === where.platform &&
            (!("isActive" in where) || row.isActive === where.isActive)
        );

        return connection
          ? { id: connection.id, sellerId: connection.sellerId }
          : null;
      },
    },
    whatsAppPhoneOwnership: {
      findMany: async ({ where }: any) =>
        rows
          .filter((row) => matchesActive(row, where))
          .map((row) => ({ ...row })),
      findFirst: async ({ where }: any) => {
        const row = rows.find(
          (candidate) =>
            candidate.phoneNumberId === where.phoneNumberId &&
            candidate.connectionId === where.connectionId
        );

        return row ? { id: row.id } : null;
      },
      update: async ({ where, data }: any) => {
        writeCalls.push({ op: "update", where, data });

        const row = rows.find((candidate) => candidate.id === where.id);

        if (!row) {
          throw new Error("mock: row not found");
        }

        Object.assign(row, data);

        return { ...row };
      },
      updateMany: async ({ where, data }: any) => {
        writeCalls.push({ op: "updateMany", where, data });

        const target = rows.filter(
          (row) =>
            row.connectionId === where.connectionId &&
            row.isActive &&
            (where.phoneNumberId && Array.isArray(where.phoneNumberId.notIn)
              ? !where.phoneNumberId.notIn.includes(row.phoneNumberId)
              : true)
        );

        target.forEach((row) => Object.assign(row, data));

        return { count: target.length };
      },
      create: async ({ data }: any) => {
        writeCalls.push({ op: "create", data });

        rows.push({ id: nextId++, isActive: true, ...data });

        return rows[rows.length - 1];
      },
    },
  };

  return { tx, rows, locks, writeCalls };
};

describe("syncConnectionOwnership", () => {
  const connections: ConnectionRow[] = [
    { id: 7, sellerId: 42, platform: "WHATSAPP", isActive: true },
    { id: 8, sellerId: 43, platform: "WHATSAPP", isActive: true },
  ];

  it("preserves valid ownership on a normal same-seller reconnect of the same connection", async () => {
    const { tx, rows, writeCalls } = makeOwnershipTx(
      [
        {
          id: 1,
          phoneNumberId: "111",
          connectionId: 7,
          sellerId: 42,
          wabaId: "WABA",
          isActive: true,
        },
      ],
      connections
    );

    await syncConnectionOwnership(
      tx,
      { id: 7, sellerId: 42, metadata: { phoneNumberIds: ["111"] } },
      "WABA"
    );

    const row = rows.find((r) => r.phoneNumberId === "111");

    assert.ok(row);
    assert.equal(row.connectionId, 7);
    assert.equal(row.sellerId, 42);
    assert.equal(row.isActive, true);
    // No new active row was created — the existing row was reused.
    assert.equal(
      writeCalls.filter((call) => call.op === "create").length,
      0
    );
  });

  it("rejects a second seller claiming an actively owned phone number", async () => {
    const { tx, rows, writeCalls } = makeOwnershipTx(
      [
        {
          id: 1,
          phoneNumberId: "111",
          connectionId: 7,
          sellerId: 42,
          wabaId: "WABA",
          isActive: true,
        },
      ],
      connections
    );

    await assert.rejects(
      syncConnectionOwnership(
        tx,
        { id: 8, sellerId: 43, metadata: { phoneNumberIds: ["111"] } },
        "WABA"
      ),
      (error: unknown) =>
        error instanceof PhoneOwnershipError &&
        error.code === "PHONE_OWNERSHIP_CONFLICT"
    );

    // The original owner's mapping is completely unchanged.
    const row = rows.find((r) => r.phoneNumberId === "111");

    assert.ok(row);
    assert.equal(row.connectionId, 7);
    assert.equal(row.sellerId, 42);
    assert.equal(row.isActive, true);

    // No ownership write of any kind happened before the abort.
    assert.equal(writeCalls.length, 0);
    // No second active row exists.
    assert.equal(
      rows.filter((r) => r.phoneNumberId === "111" && r.isActive).length,
      1
    );
  });

  it("rejects a different active connection even when it belongs to the same seller", async () => {
    const { tx, rows } = makeOwnershipTx(
      [
        {
          id: 1,
          phoneNumberId: "111",
          connectionId: 7,
          sellerId: 42,
          wabaId: "WABA",
          isActive: true,
        },
      ],
      connections
    );

    await assert.rejects(
      syncConnectionOwnership(
        tx,
        { id: 8, sellerId: 42, metadata: { phoneNumberIds: ["111"] } },
        "WABA"
      ),
      (error: unknown) =>
        error instanceof PhoneOwnershipError &&
        error.code === "PHONE_OWNERSHIP_CONFLICT"
    );

    const row = rows.find((r) => r.phoneNumberId === "111");

    assert.ok(row);
    assert.equal(row.connectionId, 7);
    assert.equal(row.isActive, true);
  });

  it("creates no duplicate active row and no second owner when reactivating its own number", async () => {
    const { tx, rows } = makeOwnershipTx(
      [
        {
          id: 1,
          phoneNumberId: "111",
          connectionId: 7,
          sellerId: 42,
          wabaId: "WABA",
          isActive: false,
        },
      ],
      connections
    );

    await syncConnectionOwnership(
      tx,
      { id: 7, sellerId: 42, metadata: { phoneNumberIds: ["111"] } },
      "WABA"
    );

    const active = rows.filter(
      (r) => r.phoneNumberId === "111" && r.isActive
    );

    assert.equal(active.length, 1);
    assert.equal(active[0].connectionId, 7);
  });

  it("acquires advisory locks for claimed AND previously active numbers in deterministic sorted order", async () => {
    const { tx, locks } = makeOwnershipTx(
      [
        {
          id: 1,
          phoneNumberId: "999",
          connectionId: 7,
          sellerId: 42,
          wabaId: "WABA",
          isActive: true,
        },
      ],
      connections
    );

    // Claims arrive deliberately unsorted; "999" is previously active.
    await syncConnectionOwnership(
      tx,
      { id: 7, sellerId: 42, metadata: { phoneNumberIds: ["b", "a"] } },
      "WABA"
    );

    assert.deepEqual(locks, ["a", "b", "999"]);
  });

  it("deactivates only its own stale numbers during cleanup and never weakens another connection's ownership", async () => {
    const { tx, rows } = makeOwnershipTx(
      [
        {
          id: 1,
          phoneNumberId: "111",
          connectionId: 7,
          sellerId: 42,
          wabaId: "WABA",
          isActive: true,
        },
        {
          id: 2,
          phoneNumberId: "999",
          connectionId: 7,
          sellerId: 42,
          wabaId: "WABA",
          isActive: true,
        },
        {
          id: 3,
          phoneNumberId: "999",
          connectionId: 8,
          sellerId: 43,
          wabaId: "WABA",
          isActive: true,
        },
      ],
      connections
    );

    // Connection 7 drops "999" from its claims but keeps "111".
    await syncConnectionOwnership(
      tx,
      { id: 7, sellerId: 42, metadata: { phoneNumberIds: ["111"] } },
      "WABA"
    );

    const own111 = rows.find(
      (r) => r.phoneNumberId === "111" && r.connectionId === 7
    );
    const own999 = rows.find(
      (r) => r.phoneNumberId === "999" && r.connectionId === 7
    );
    const other999 = rows.find(
      (r) => r.phoneNumberId === "999" && r.connectionId === 8
    );

    assert.ok(own111?.isActive);
    assert.equal(own999?.isActive, false);
    // The other connection's ownership of "999" is untouched.
    assert.ok(other999?.isActive);
    assert.equal(other999?.sellerId, 43);
  });

  it("rejects the sync before any write when a conflict exists, so a caller transaction can roll back atomically", async () => {
    const { tx, writeCalls } = makeOwnershipTx(
      [
        {
          id: 1,
          phoneNumberId: "111",
          connectionId: 7,
          sellerId: 42,
          wabaId: "WABA",
          isActive: true,
        },
      ],
      connections
    );

    await assert.rejects(
      syncConnectionOwnership(
        tx,
        { id: 8, sellerId: 43, metadata: { phoneNumberIds: ["111", "222"] } },
        "WABA"
      )
    );

    // Even the non-conflicting number "222" was not written:
    // the abort is all-or-nothing.
    assert.equal(writeCalls.length, 0);
  });
});

/* ----------------------------------------------------
   assertOwnedPhoneNumberForSend — outbound send guard
   (audit finding H-3)
---------------------------------------------------- */

describe("assertOwnedPhoneNumberForSend", () => {
  const connections: ConnectionRow[] = [
    { id: 7, sellerId: 42, platform: "WHATSAPP", isActive: true },
    { id: 8, sellerId: 43, platform: "WHATSAPP", isActive: true },
  ];

  const ownershipRow = (
    id: number,
    phoneNumberId: string,
    connectionId: number,
    sellerId: number
  ): OwnershipRow => ({
    id,
    phoneNumberId,
    connectionId,
    sellerId,
    wabaId: "WABA",
    isActive: true,
  });

  it("resolves for the active owner under the per-phone lock", async () => {
    const { tx, locks } = makeOwnershipTx(
      [ownershipRow(1, "111", 7, 42)],
      connections
    );

    const owner = await assertOwnedPhoneNumberForSend(tx, {
      sellerId: 42,
      connectionId: 7,
      phoneNumberId: "111",
    });

    assert.deepEqual(owner, { connectionId: 7, sellerId: 42 });
    // The lock is acquired BEFORE ownership is read.
    assert.deepEqual(locks, ["111"]);
  });

  it("rejects a seller that does not own the number with PHONE_NOT_OWNED_BY_SELLER", async () => {
    const { tx } = makeOwnershipTx(
      [ownershipRow(1, "111", 7, 42)],
      connections
    );

    await assert.rejects(
      assertOwnedPhoneNumberForSend(tx, {
        sellerId: 43,
        connectionId: 8,
        phoneNumberId: "111",
      }),
      (error: unknown) =>
        error instanceof PhoneOwnershipError &&
        error.code === "PHONE_NOT_OWNED_BY_SELLER"
    );
  });

  it("rejects a same-seller send through a different connection than the active owner", async () => {
    const { tx } = makeOwnershipTx(
      [ownershipRow(1, "111", 7, 42)],
      connections
    );

    await assert.rejects(
      assertOwnedPhoneNumberForSend(tx, {
        sellerId: 42,
        connectionId: 8,
        phoneNumberId: "111",
      }),
      (error: unknown) =>
        error instanceof PhoneOwnershipError &&
        error.code === "PHONE_NOT_OWNED_BY_SELLER"
    );
  });

  it("fails closed with UNKNOWN_PHONE_NUMBER when no active ownership exists", async () => {
    const { tx } = makeOwnershipTx([], connections);

    await assert.rejects(
      assertOwnedPhoneNumberForSend(tx, {
        sellerId: 42,
        connectionId: 7,
        phoneNumberId: "404",
      }),
      (error: unknown) =>
        error instanceof PhoneOwnershipError &&
        error.code === "UNKNOWN_PHONE_NUMBER"
    );
  });

  it("fails closed with OWNER_CONNECTION_INACTIVE when the owning connection is inactive", async () => {
    const { tx } = makeOwnershipTx(
      [ownershipRow(1, "111", 7, 42)],
      [{ id: 7, sellerId: 42, platform: "WHATSAPP", isActive: false }]
    );

    await assert.rejects(
      assertOwnedPhoneNumberForSend(tx, {
        sellerId: 42,
        connectionId: 7,
        phoneNumberId: "111",
      }),
      (error: unknown) =>
        error instanceof PhoneOwnershipError &&
        error.code === "OWNER_CONNECTION_INACTIVE"
    );
  });
});
