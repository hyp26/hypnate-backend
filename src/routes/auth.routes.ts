import { Router } from "express";
import { register, login, getProfile, updateProfile, logout } from "../controllers/auth.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.get("/profile", verifyToken, getProfile);
router.put("/profile", verifyToken, updateProfile);
router.post("/logout", verifyToken, logout);

export default router;
