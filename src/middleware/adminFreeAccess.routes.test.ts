import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import adminRoutes from "../routes/admin.routes";
import { requireAdminRoles } from "./adminAuth.middleware";

/*
 * Route-authorization regression tests for the SUPER_ADMIN
 * free-access endpoints.
 *
 * 1. Every free-access route (POST/PATCH/DELETE
 *    /api/admin/sellers/:id/free-access) must be wired with
 *    verifyAdminToken AND requireAdminRoles("SUPER_ADMIN").
 * 2. requireAdminRoles("SUPER_ADMIN") must reject ADMIN and
 *    SUPPORT accounts with 403 even when they reach the
 *    middleware directly (defense in depth against a future
 *    route wiring mistake).
 *
 * NOT EXECUTED in the authoring environment (no Node.js
 * available) — see the PR description for the exact
 * verification status.
 */

interface RouteInfo {
  path: string;
  methods: string[];
  middlewareNames: string[];
}

const collectRoutes = (router: unknown): RouteInfo[] => {
  const stack = (router as { stack?: unknown[] }).stack ?? [];
  const routes: RouteInfo[] = [];

  for (const layer of stack) {
    const route = (layer as { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { name: string } }> } }).route;

    if (!route || !route.path) {
      continue;
    }

    routes.push({
      path: route.path,
      methods: Object.keys(route.methods ?? {}),
      middlewareNames: (route.stack ?? []).map(
        (entry) => entry.handle?.name ?? ""
      ),
    });
  }

  return routes;
};

describe("free-access route authorization wiring", () => {
  it("exposes exactly the three free-access endpoints", () => {
    const routes = collectRoutes(adminRoutes).filter((route) =>
      route.path.includes("/free-access")
    );

    assert.equal(routes.length, 3);
  });

  it("each free-access route requires verifyAdminToken and SUPER_ADMIN role", () => {
    const routes = collectRoutes(adminRoutes).filter((route) =>
      route.path.includes("/free-access")
    );

    assert.equal(routes.length, 3);

    for (const route of routes) {
      assert.equal(route.path, "/sellers/:id/free-access", `unexpected path ${route.path}`);
      assert.equal(route.middlewareNames[0], "verifyAdminToken");
      assert.ok(
        route.middlewareNames.includes("requireAdminRolesMiddleware"),
        `${route.methods.join("/")} missing requireAdminRoles guard`
      );
    }

    const methods = routes.flatMap((route) => route.methods).sort();
    assert.deepEqual(methods, ["delete", "patch", "post"]);
  });

});

describe("requireAdminRoles SUPER_ADMIN enforcement", () => {
  const run = (role: string | undefined, roles: Array<"SUPER_ADMIN" | "ADMIN" | "SUPPORT">) => {
    const result: { status: number | null; nexted: boolean; body: unknown } = {
      status: null,
      nexted: false,
      body: null,
    };

    const req = { adminUser: role ? { id: 1, role } : undefined } as any;

    const res = {
      status(code: number) {
        result.status = code;
        return res;
      },
      json(body: unknown) {
        result.body = body;
        return res;
      },
    } as any;

    requireAdminRoles(...roles)(req, res, () => {
      result.nexted = true;
    });

    return result;
  };

  it("rejects ADMIN with 403", () => {
    const result = run("ADMIN", ["SUPER_ADMIN"]);
    assert.equal(result.status, 403);
    assert.equal(result.nexted, false);
  });

  it("rejects SUPPORT with 403", () => {
    const result = run("SUPPORT", ["SUPER_ADMIN"]);
    assert.equal(result.status, 403);
    assert.equal(result.nexted, false);
  });

  it("allows SUPER_ADMIN", () => {
    const result = run("SUPER_ADMIN", ["SUPER_ADMIN"]);
    assert.equal(result.nexted, true);
    assert.equal(result.status, null);
  });

  it("rejects an unauthenticated request with 401", () => {
    const result = run(undefined, ["SUPER_ADMIN"]);
    assert.equal(result.status, 401);
    assert.equal(result.nexted, false);
  });
});
