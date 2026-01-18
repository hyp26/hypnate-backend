import { Router, RequestHandler } from "express";
import {
  register,
  login,
  forgotPassword,
  getProfile,
  updateProfile,
  logout,
} from "../controllers/auth.controller";
import { resetPassword } from "../controllers/passwordReset.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();

/* ---------------------------
   PUBLIC
---------------------------- */
router.post("/register", register);
router.post("/login", login);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password/:token", resetPassword);


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
