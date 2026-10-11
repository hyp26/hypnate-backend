import { Router, RequestHandler } from "express";
import {
  register,
  login,
  logout,
  refreshToken,
  forgotPassword,
  getProfile,
  updateProfile,
  verifyEmail,
  resendVerification
} from "../controllers/auth.controller";
import { resetPassword } from "../controllers/passwordReset.controller";
import { verifyToken } from "../middleware/authMiddleware";
import { requireRegistrationEnabled } from "../middleware/featureFlag.middleware";


const router = Router();

/* ---------------------------
   PUBLIC
---------------------------- */
/*
 * P1-004: the registration gate runs BEFORE the register controller,
 * so when the newUserRegistration feature flag is disabled the request
 * is rejected with 403 REGISTRATION_DISABLED before any
 * account-creation side effect (Seller/User creation, verification
 * email, refresh session) can happen. The stored backend flag value
 * is authoritative; the request body is never consulted for it.
 */
router.post(
  "/register",
  requireRegistrationEnabled as RequestHandler,
  register as RequestHandler
);

router.post("/login", login as RequestHandler);
router.post("/forgot-password", forgotPassword as RequestHandler);
router.post("/reset-password/:token", resetPassword as RequestHandler );

// Refresh access token using httpOnly refresh cookie
// Frontend calls this when it gets 401 + code: "TOKEN_EXPIRED"
router.post("/refresh", refreshToken as RequestHandler);

// Email verification routes
router.post("/verify-email", verifyEmail);
router.post("/resend-verification", resendVerification);

/* ---------------------------
   PROTECTED
---------------------------- */
router.get(
  "/profile",
  verifyToken as RequestHandler,
  getProfile as RequestHandler
);

router.put(
  "/profile",
  verifyToken as RequestHandler,
  updateProfile as RequestHandler
);

router.post(
  "/logout",
  verifyToken as RequestHandler,
  logout as RequestHandler
);

export default router;