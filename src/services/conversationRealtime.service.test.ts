import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emitToConversationRoom } from "./conversationRealtime.service";

/*
 * Regression tests for the tenant-safe conversation-room
 * emission helper (audit findings: realtime authorization).
 *
 * Prisma is NOT exercised here: emitToConversationRoom performs
 * no database access, so these are pure socket-level tests.
 * The OWNERSHIP-aware path (emitAuthorizedConversationEvents)
 * requires a database and the per-phone advisory lock — its
 * tests live in conversationRealtimeOwnership.db.test.ts and
 * MUST be run against a disposable PostgreSQL database.
 *
 * NOT EXECUTED in the authoring environment (no Node.js
 * available) — run with
 * `node --test dist/services/conversationRealtime.service.test.js`
 * after `npx prisma generate && npm run build`.
 */

const makeSocket = (sellerId: number | undefined) => {
  const emitted: Array<{ event: string; payload: unknown }> = [];

  return {
    data: sellerId === undefined ? {} : { sellerId },
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
    },
    emitted,
  };
};

/*
 * The production helper (asIo) requires EVERY room handle to
 * provide BOTH fetchSockets() and emit() — an io lacking either
 * is rejected. The mock therefore implements both so the tests
 * exercise the real delivery path rather than the early
 * guard return.
 */
const makeIo = (sockets: any[]) => {
  const roomEmits: Array<{ room: string; event: string; payload: unknown }> =
    [];

  return {
    in: (room: string) => ({
      fetchSockets: async () => sockets,
      emit: (event: string, payload: unknown) => {
        roomEmits.push({ room, event, payload });
      },
    }),
    roomEmits,
  };
};

describe("emitToConversationRoom — per-socket owner filter", () => {
  it("delivers only to sockets whose sellerId matches the authorized seller", async () => {
    const ownerSocket = makeSocket(10);
    const foreignSocket = makeSocket(20);
    const mysterySocket = makeSocket(undefined);

    const delivered = await emitToConversationRoom(
      makeIo([ownerSocket, foreignSocket, mysterySocket]),
      1,
      10,
      "new_message",
      { id: 1 }
    );

    assert.equal(delivered, 1);
    assert.equal(ownerSocket.emitted.length, 1);
    assert.equal(ownerSocket.emitted[0].event, "new_message");
    assert.deepEqual(foreignSocket.emitted, []);
    assert.deepEqual(mysterySocket.emitted, []);
  });

  it("returns 0 without io or with an invalid conversation id", async () => {
    assert.equal(
      await emitToConversationRoom(null, 1, 10, "new_message", {}),
      0
    );
    assert.equal(
      await emitToConversationRoom({}, 1, 10, "new_message", {}),
      0
    );
    assert.equal(
      await emitToConversationRoom(makeIo([]), 1.5, 10, "new_message", {}),
      0
    );
  });

  it("fails soft (returns delivered count) when fetchSockets throws", async () => {
    /*
     * fetchSockets() throws but the room handle still exposes
     * a valid emit(): the test exercises the genuine adapter
     * failure path inside delivery, not the asIo() guard.
     */
    const io = {
      in: (_room: string) => ({
        fetchSockets: async () => {
          throw new Error("adapter gone");
        },
        emit: (_event: string, _payload: unknown) => {
          // Intentionally not called: fetchSockets fails first.
        },
      }),
    };

    const delivered = await emitToConversationRoom(
      io,
      1,
      10,
      "conversation_updated",
      {}
    );

    assert.equal(delivered, 0);
  });

  it("delivers to every matching socket (multiple devices)", async () => {
    const sockets = [makeSocket(10), makeSocket(10), makeSocket(99)];

    const delivered = await emitToConversationRoom(
      makeIo(sockets),
      3,
      10,
      "message_status_updated",
      { conversationId: 3, status: "DELIVERED" }
    );

    assert.equal(delivered, 2);
    assert.equal(sockets[0].emitted.length, 1);
    assert.equal(sockets[1].emitted.length, 1);
    assert.deepEqual(sockets[2].emitted, []);
  });
});
