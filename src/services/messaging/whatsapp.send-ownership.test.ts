import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectOutboundPhoneNumberId } from "./whatsapp.service";

/*
 * Unit tests for the outbound WhatsApp phone-number selection
 * (audit finding H-3).
 *
 * The full sendWhatsAppMessageForSeller path (Prisma + Meta API)
 * is exercised by integration/database-backed tests — see
 * whatsappOwnership.db.test.ts. These tests cover the pure
 * selection logic that prevents an arbitrary metadata number
 * from ever being chosen.
 *
 * NOT EXECUTED in the authoring environment (no Node.js
 * available) — run with
 * `node --test dist/services/messaging/whatsapp.send-ownership.test.js`
 * after `npm run build`.
 */

describe("selectOutboundPhoneNumberId", () => {
  it("uses an explicitly requested phone-number ID as given (it is ownership-validated by the caller)", () => {
    const selection = selectOutboundPhoneNumberId(" 555 ", [
      "111",
      "222",
    ]);

    assert.deepEqual(selection, {
      kind: "selected",
      phoneNumberId: "555",
    });
  });

  it("resolves the single active owned number when none was requested", () => {
    const selection = selectOutboundPhoneNumberId(undefined, ["111"]);

    assert.deepEqual(selection, {
      kind: "selected",
      phoneNumberId: "111",
    });
  });

  it("never selects an arbitrary first number when multiple numbers are owned", () => {
    const selection = selectOutboundPhoneNumberId(undefined, [
      "111",
      "222",
    ]);

    assert.equal(selection.kind, "ambiguous");

    assert.deepEqual(
      (selection as { phoneNumberIds: string[] }).phoneNumberIds,
      ["111", "222"]
    );
  });

  it("deduplicates and trims candidates before deciding", () => {
    const selection = selectOutboundPhoneNumberId(undefined, [
      " 111 ",
      "111",
    ]);

    assert.deepEqual(selection, {
      kind: "selected",
      phoneNumberId: "111",
    });
  });

  it("fails closed with none when the connection owns no active numbers", () => {
    assert.deepEqual(
      selectOutboundPhoneNumberId(undefined, []),
      { kind: "none" }
    );
  });

  it("treats an empty/whitespace requested ID as absent", () => {
    assert.deepEqual(
      selectOutboundPhoneNumberId("   ", ["111"]),
      { kind: "selected", phoneNumberId: "111" }
    );

    assert.deepEqual(selectOutboundPhoneNumberId("   ", []), {
      kind: "none",
    });
  });
});
