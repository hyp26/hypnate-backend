import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildTicketListWhere,
  buildTicketLookupWhere,
} from "./adminTickets.controller";

const support = { role: "SUPPORT", id: 9 };
const admin = { role: "ADMIN", id: 5 };
const superAdmin = { role: "SUPER_ADMIN", id: 1 };

describe("buildTicketListWhere — SUPPORT sees only assigned tickets", () => {
  it("scopes SUPPORT to their own tickets at the query level", () => {
    const where = buildTicketListWhere({}, support);
    assert.deepEqual(where, { assignedToAdminId: 9 });
  });

  it("overrides an assignedToAdminId filter supplied by SUPPORT", () => {
    // A SUPPORT user cannot enumerate another admin's tickets by
    // requesting that admin's id: the DB-level scope wins.
    const where = buildTicketListWhere(
      { assignedToAdminId: 5 },
      support
    );
    assert.equal(where.assignedToAdminId, 9);
  });

  it("keeps other SUPPORT filters alongside the assignment scope", () => {
    const where = buildTicketListWhere(
      { status: "OPEN", priority: "HIGH" },
      support
    );
    assert.equal(where.status, "OPEN");
    assert.equal(where.priority, "HIGH");
    assert.equal(where.assignedToAdminId, 9);
  });

  it("scopes the search filter for SUPPORT to assigned tickets", () => {
    const where = buildTicketListWhere({ search: "refund" }, support);
    assert.equal(where.assignedToAdminId, 9);
    assert.ok(Array.isArray(where.OR));
  });
});

describe("buildTicketListWhere — ADMIN/SUPER_ADMIN retain unscoped listing", () => {
  it("does not scope ADMIN", () => {
    const where = buildTicketListWhere({}, admin);
    assert.deepEqual(where, {});
  });

  it("does not scope SUPER_ADMIN", () => {
    const where = buildTicketListWhere({}, superAdmin);
    assert.deepEqual(where, {});
  });

  it("respects an explicit assignedToAdminId filter for ADMIN", () => {
    const where = buildTicketListWhere(
      { assignedToAdminId: 9 },
      admin
    );
    assert.equal(where.assignedToAdminId, 9);
  });

  it("applies status/priority/search filters unchanged for ADMIN", () => {
    const where = buildTicketListWhere(
      { status: "OPEN", priority: "LOW", search: "x" },
      admin
    );
    assert.equal(where.status, "OPEN");
    assert.equal(where.priority, "LOW");
    assert.ok(Array.isArray(where.OR));
    assert.equal(where.assignedToAdminId, undefined);
  });
});

describe("buildTicketLookupWhere — single-ticket retrieval", () => {
  it("includes the SUPPORT assignment scope in the lookup query", () => {
    const where = buildTicketLookupWhere("TKT-2026-000001", support);
    assert.equal(where.assignedToAdminId, 9);
    assert.ok(Array.isArray(where.OR));
  });

  it("does not scope ADMIN or SUPER_ADMIN lookups", () => {
    assert.equal(
      buildTicketLookupWhere("TKT-2026-000001", admin).assignedToAdminId,
      undefined
    );
    assert.equal(
      buildTicketLookupWhere("TKT-2026-000001", superAdmin).assignedToAdminId,
      undefined
    );
  });

  it("preserves the ticketNumber/numeric-id OR lookup", () => {
    const where = buildTicketLookupWhere("TKT-2026-000001", admin);
    assert.deepEqual(where.OR, [
      { ticketNumber: "TKT-2026-000001" },
      { id: Number("TKT-2026-000001") || -1 },
    ]);

    const numeric = buildTicketLookupWhere("42", admin);
    assert.deepEqual((numeric as any).OR, [
      { ticketNumber: "42" },
      { id: 42 },
    ]);
  });

  it("keeps the non-matching sentinel for invalid identifiers", () => {
    const where = buildTicketLookupWhere("not-a-ticket", admin);
    assert.deepEqual((where as any).OR, [
      { ticketNumber: "not-a-ticket" },
      { id: -1 },
    ]);
  });
});
