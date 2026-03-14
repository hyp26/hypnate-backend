import { Router, RequestHandler } from "express";
import {
  register,
  login,
  logout,
  refreshToken,
  forgotPassword,
  getProfile,
  updateProfile,
} from "../controllers/auth.controller";
import { resetPassword } from "../controllers/passwordReset.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();

/* ---------------------------
   PUBLIC
---------------------------- */
router.post("/register", register as RequestHandler);
router.post("/login", login as RequestHandler);
router.post("/forgot-password", forgotPassword as RequestHandler);
router.post("/reset-password/:token", resetPassword);

// Refresh access token using httpOnly refresh cookie
// Frontend calls this when it gets 401 + code: "TOKEN_EXPIRED"
router.post("/refresh", refreshToken as RequestHandler);

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