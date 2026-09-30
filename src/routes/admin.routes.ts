import { Router, RequestHandler } from "express";
import {
  verifyAdminToken,
  requireAdminPermission,
  requireAdminRoles,
  AdminAuthRequest,
} from "../middleware/adminAuth.middleware";

// Controllers
import {
  adminLogin,
  adminRefresh,
  adminLogout,
  adminProfile,
  adminChangePassword,
} from "../controllers/admin/adminAuth.controller";
import {
  listAdminUsers,
  createAdminAccount,
  updateAdminRole,
  updateAdminStatus,
  deleteAdminAccount,
} from "../controllers/admin/adminUsers.controller";
import {
  listSellers,
  getSeller,
  updateSellerStatus,
} from "../controllers/admin/adminSellers.controller";
import { listCustomers } from "../controllers/admin/adminCustomers.controller";
import {
  listOrders,
  getOrder,
  updateOrderStatus,
} from "../controllers/admin/adminOrders.controller";
import {
  listSubscriptions,
  updateSubscription,
} from "../controllers/admin/adminSubscriptions.controller";
import {
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  addTicketMessage,
  deleteTicket,
} from "../controllers/admin/adminTickets.controller";
import {
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from "../controllers/admin/adminAnnouncements.controller";
import {
  listFaqs,
  createFaq,
  updateFaq,
  deleteFaq,
} from "../controllers/admin/adminFaq.controller";
import {
  listContentPages,
  createContentPage,
  updateContentPage,
  deleteContentPage,
} from "../controllers/admin/adminContent.controller";
import { listAuditLogs } from "../controllers/admin/adminAudit.controller";
import {
  getSettings,
  updateSettings,
  getFeatureFlags,
  updateFeatureFlags,
} from "../controllers/admin/adminSettings.controller";
import {
  getAdminStats,
  getRevenueChart,
  getAdminAnalytics,
} from "../controllers/admin/adminStats.controller";

const router = Router();

/* ----------------------------------------------------
   CAST HELPERS
---------------------------------------------------- */

/**
 * All admin controllers read the resolved admin from
 * req.adminUser, so they are cast to the admin request
 * shape at the router boundary.
 */
const adminHandler = (fn: (req: AdminAuthRequest, res: any, next: any) => Promise<void>): RequestHandler =>
  fn as unknown as RequestHandler;

const guard = [verifyAdminToken as RequestHandler];

/* ----------------------------------------------------
   AUTH (public)
---------------------------------------------------- */

router.post("/auth/login", adminLogin as RequestHandler);
router.post("/auth/refresh", adminRefresh as RequestHandler);

/* ----------------------------------------------------
   AUTH (protected)
---------------------------------------------------- */

router.post("/auth/logout", ...guard, adminHandler(adminLogout));
router.get("/auth/profile", ...guard, adminHandler(adminProfile));
router.post("/auth/change-password", ...guard, adminHandler(adminChangePassword));

/* ----------------------------------------------------
   ADMIN USERS
---------------------------------------------------- */

router.get(
  "/users",
  ...guard,
  requireAdminPermission("VIEW_ADMIN_USERS") as RequestHandler,
  adminHandler(listAdminUsers)
);

router.post(
  "/users",
  ...guard,
  ((req: AdminAuthRequest, res, next) => {
    // Permission depends on the requested role, mirroring
    // the frontend store's rules.
    const role = (req.body?.role ?? "SUPPORT").toUpperCase();
    const permission =
      role === "ADMIN" ? "CREATE_ADMIN" : "CREATE_SUPPORT";

    return requireAdminPermission(permission)(req, res, next);
  }) as RequestHandler,
  adminHandler(createAdminAccount)
);

router.patch(
  "/users/:id/role",
  ...guard,
  requireAdminPermission("CHANGE_SUPPORT_ROLE") as RequestHandler,
  adminHandler(updateAdminRole)
);

router.patch(
  "/users/:id/status",
  ...guard,
  requireAdminPermission("CHANGE_ADMIN_STATUS") as RequestHandler,
  adminHandler(updateAdminStatus)
);

router.delete(
  "/users/:id",
  ...guard,
  requireAdminPermission("DELETE_SUPPORT") as RequestHandler,
  adminHandler(deleteAdminAccount)
);

/* ----------------------------------------------------
   SELLERS
---------------------------------------------------- */

router.get("/sellers", ...guard, adminHandler(listSellers));
router.get("/sellers/:id", ...guard, adminHandler(getSeller));
router.patch(
  "/sellers/:id/status",
  ...guard,
  requireAdminRoles("SUPER_ADMIN", "ADMIN") as RequestHandler,
  adminHandler(updateSellerStatus)
);

/* ----------------------------------------------------
   CUSTOMERS
---------------------------------------------------- */

router.get("/customers", ...guard, adminHandler(listCustomers));

/* ----------------------------------------------------
   ORDERS
---------------------------------------------------- */

router.get("/orders", ...guard, adminHandler(listOrders));
router.get("/orders/:id", ...guard, adminHandler(getOrder));
router.patch(
  "/orders/:id/status",
  ...guard,
  requireAdminRoles("SUPER_ADMIN", "ADMIN") as RequestHandler,
  adminHandler(updateOrderStatus)
);

/* ----------------------------------------------------
   SUBSCRIPTIONS
---------------------------------------------------- */

router.get("/subscriptions", ...guard, adminHandler(listSubscriptions));
router.patch(
  "/subscriptions/:id",
  ...guard,
  requireAdminRoles("SUPER_ADMIN", "ADMIN") as RequestHandler,
  adminHandler(updateSubscription)
);

/* ----------------------------------------------------
   TICKETS
---------------------------------------------------- */

router.get("/tickets", ...guard, adminHandler(listTickets));
router.get("/tickets/:id", ...guard, adminHandler(getTicket));
router.post("/tickets", ...guard, adminHandler(createTicket));
router.patch("/tickets/:id", ...guard, adminHandler(updateTicket));
router.post("/tickets/:id/messages", ...guard, adminHandler(addTicketMessage));
router.delete(
  "/tickets/:id",
  ...guard,
  requireAdminRoles("SUPER_ADMIN", "ADMIN") as RequestHandler,
  adminHandler(deleteTicket)
);

/* ----------------------------------------------------
   ANNOUNCEMENTS
---------------------------------------------------- */

router.get("/announcements", ...guard, adminHandler(listAnnouncements));
router.post("/announcements", ...guard, adminHandler(createAnnouncement));
router.patch("/announcements/:id", ...guard, adminHandler(updateAnnouncement));
router.delete("/announcements/:id", ...guard, adminHandler(deleteAnnouncement));

/* ----------------------------------------------------
   FAQ
---------------------------------------------------- */

router.get("/faq", ...guard, adminHandler(listFaqs));
router.post("/faq", ...guard, adminHandler(createFaq));
router.patch("/faq/:id", ...guard, adminHandler(updateFaq));
router.delete("/faq/:id", ...guard, adminHandler(deleteFaq));

/* ----------------------------------------------------
   CONTENT PAGES
---------------------------------------------------- */

router.get("/content", ...guard, adminHandler(listContentPages));
router.post("/content", ...guard, adminHandler(createContentPage));
router.patch("/content/:id", ...guard, adminHandler(updateContentPage));
router.delete("/content/:id", ...guard, adminHandler(deleteContentPage));

/* ----------------------------------------------------
   AUDIT LOGS
---------------------------------------------------- */

router.get(
  "/audit-logs",
  ...guard,
  requireAdminRoles("SUPER_ADMIN", "ADMIN") as RequestHandler,
  adminHandler(listAuditLogs)
);

/* ----------------------------------------------------
   SETTINGS + FEATURE FLAGS
---------------------------------------------------- */

router.get("/settings", ...guard, adminHandler(getSettings));
router.put("/settings", ...guard, adminHandler(updateSettings));
router.get("/feature-flags", ...guard, adminHandler(getFeatureFlags));
router.put("/feature-flags", ...guard, adminHandler(updateFeatureFlags));

/* ----------------------------------------------------
   STATS + ANALYTICS
---------------------------------------------------- */

router.get("/stats", ...guard, adminHandler(getAdminStats));
router.get("/stats/charts", ...guard, adminHandler(getRevenueChart));
router.get("/analytics", ...guard, adminHandler(getAdminAnalytics));

export default router;
