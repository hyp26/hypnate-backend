import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Request, Response, NextFunction } from "express";
import router from "./admin.routes";
import {
  getAdminPermissions,
  requireAdminRoles,
  type AdminAuthRequest,
} from "../middleware/adminAuth.middleware";

/* ----------------------------------------------------
   HELPERS
---------------------------------------------------- */

interface RouteInfo {
  method: string;
  path: string;
  handlers: string[];
}

/**
 * Walk the real admin router and collect, for every registered
 * route, its HTTP method and the names of the middleware
 * handlers in execution order. This verifies the actual route
 * wiring — a route that lost its authorization middleware
 * fails these assertions.
 */
function collectRoutes(r: any): RouteInfo[] {
  const routes: RouteInfo[] = [];

  for (const layer of r.stack) {
    const route = layer?.route;
    if (!route || !route.path) continue;

    const methods =
      route.methods && typeof route.methods === "object"
        ? Object.keys(route.methods)
            .filter((m) => (route.methods as any)[m])
            .filter((m) => m !== "head")
            .map((m) => m.toUpperCase())
        : ["?"];

    const handlers = (route.stack || []).map(
      (l: any) =>
        (typeof l.handle === "function" ? l.handle.name : "") || "<anonymous>"
    );

    for (const method of methods) {
      routes.push({ method, path: String(route.path), handlers });
    }
  }

  return routes;
}

const ROUTES = collectRoutes(router);

const routeFor = (method: string, path: string): RouteInfo => {
  const found = ROUTES.find(
    (r) => r.method === method && r.path === path
  );
  if (!found) {
    assert.fail(
      `Expected route ${method} ${path} to be registered. ` +
        `Registered: ${ROUTES.map((r) => `${r.method} ${r.path}`).join(", ")}`
    );
  }
  return found;
};

const hasAuth = (r: RouteInfo) => r.handlers.includes("verifyAdminToken");
const hasAdminOnly = (r: RouteInfo) =>
  r.handlers.includes("requireAdminRolesMiddleware");

/* ----------------------------------------------------
   P1-002: privileged endpoints must require ADMIN+
---------------------------------------------------- */

describe("admin routes: privileged endpoints are ADMIN-only", () => {
  const privileged: Array<[string, string]> = [
    // Settings
    ["GET", "/settings"],
    ["PUT", "/settings"],
    // Feature flags
    ["GET", "/feature-flags"],
    ["PUT", "/feature-flags"],
    // Announcements (content management)
    ["GET", "/announcements"],
    ["POST", "/announcements"],
    ["PATCH", "/announcements/:id"],
    ["DELETE", "/announcements/:id"],
    // FAQ (content management)
    ["GET", "/faq"],
    ["POST", "/faq"],
    ["PATCH", "/faq/:id"],
    ["DELETE", "/faq/:id"],
    // Content pages (content management)
    ["GET", "/content"],
    ["POST", "/content"],
    ["PATCH", "/content/:id"],
    ["DELETE", "/content/:id"],
    // Platform-wide stats / analytics (tenant-wide data)
    ["GET", "/stats"],
    ["GET", "/stats/charts"],
    ["GET", "/analytics"],
  ];

  for (const [method, path] of privileged) {
    it(`${method} ${path} requires SUPER_ADMIN/ADMIN`, () => {
      const r = routeFor(method, path);
      assert.equal(hasAuth(r), true, `${method} ${path} must run verifyAdminToken`);
      assert.equal(
        hasAdminOnly(r),
        true,
        `${method} ${path} must enforce requireAdminRoles("SUPER_ADMIN", "ADMIN")`
      );
    });
  }
});

/* ----------------------------------------------------
   SUPPORT workflows must keep working
---------------------------------------------------- */

describe("admin routes: support workflows remain accessible to SUPPORT", () => {
  const supportRoutes: Array<[string, string]> = [
    ["POST", "/auth/logout"],
    ["GET", "/auth/profile"],
    ["POST", "/auth/change-password"],
    // Read-only tenant lookups for support work.
    ["GET", "/sellers"],
    ["GET", "/sellers/:id"],
    ["GET", "/customers"],
    ["GET", "/orders"],
    ["GET", "/orders/:id"],
    ["GET", "/subscriptions"],
    // Ticket workflows are SUPPORT's core job
    // (the controller already scopes SUPPORT to
    // assigned tickets).
    ["GET", "/tickets"],
    ["GET", "/tickets/:id"],
    ["POST", "/tickets"],
    ["PATCH", "/tickets/:id"],
    ["POST", "/tickets/:id/messages"],
  ];

  for (const [method, path] of supportRoutes) {
    it(`${method} ${path} is authenticated but not role-restricted`, () => {
      const r = routeFor(method, path);
      assert.equal(hasAuth(r), true, `${method} ${path} must run verifyAdminToken`);
      assert.equal(
        hasAdminOnly(r),
        false,
        `${method} ${path} must remain usable by SUPPORT`
      );
    });
  }
});

/* ----------------------------------------------------
   Every non-public admin route must authenticate
---------------------------------------------------- */

describe("admin routes: authentication coverage", () => {
  const publicRoutes = new Set(["POST /auth/login", "POST /auth/refresh"]);

  it("no admin route skips verifyAdminToken except the public auth routes", () => {
    const offenders = ROUTES.filter(
      (r) => !publicRoutes.has(`${r.method} ${r.path}`) && !hasAuth(r)
    ).map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(offenders, []);
  });

  it("public auth routes are not guarded by verifyAdminToken", () => {
    assert.equal(hasAuth(routeFor("POST", "/auth/login")), false);
    assert.equal(hasAuth(routeFor("POST", "/auth/refresh")), false);
  });
});

/* ----------------------------------------------------
   requireAdminRoles behavior (SUPPORT empty permission set)
---------------------------------------------------- */

describe("requireAdminRoles middleware behavior", () => {
  const run = (role: string | undefined) => {
    let status: number | undefined;
    let body: any;
    let allowed = false;

    const req = {
      adminUser: role
        ? {
            id: 1,
            email: "a@b.c",
            firstName: "A",
            lastName: "B",
            role,
            status: "ACTIVE",
            avatarUrl: null,
          }
        : undefined,
    } as unknown as AdminAuthRequest;

    const res = {
      status(code: number) {
        status = code;
        return this as unknown as Response;
      },
      json(payload: any) {
        body = payload;
        return this as unknown as Response;
      },
    } as unknown as Response;

    const next: NextFunction = () => {
      allowed = true;
    };

    const middleware = requireAdminRoles("SUPER_ADMIN", "ADMIN");
    middleware(req, res, next);

    return { status, body, allowed, name: middleware.name };
  };

  it("denies SUPPORT with the standard forbidden response", () => {
    const r = run("SUPPORT");
    assert.equal(r.allowed, false);
    assert.equal(r.status, 403);
    assert.equal(r.body.message, "You do not have access to this resource");
  });

  it("allows ADMIN", () => {
    const r = run("ADMIN");
    assert.equal(r.allowed, true);
    assert.equal(r.status, undefined);
  });

  it("allows SUPER_ADMIN", () => {
    const r = run("SUPER_ADMIN");
    assert.equal(r.allowed, true);
  });

  it("requires prior authentication (401 when adminUser missing)", () => {
    const r = run(undefined);
    assert.equal(r.allowed, false);
    assert.equal(r.status, 401);
    assert.equal(r.body.message, "Admin authentication required");
  });

  it("names its middleware for route-level introspection", () => {
    assert.equal(run("ADMIN").name, "requireAdminRolesMiddleware");
  });
});

/* ----------------------------------------------------
   SUPPORT permission model
---------------------------------------------------- */

describe("SUPPORT permission model", () => {
  it("SUPPORT has an empty permission set", () => {
    assert.deepEqual(getAdminPermissions("SUPPORT"), []);
  });

  it("ADMIN and SUPER_ADMIN retain their permissions", () => {
    const admin = getAdminPermissions("ADMIN");
    const superAdmin = getAdminPermissions("SUPER_ADMIN");
    assert.ok(admin.includes("VIEW_ADMIN_USERS"));
    assert.ok(superAdmin.includes("CREATE_ADMIN"));
    assert.ok(superAdmin.length > admin.length);
  });
});
