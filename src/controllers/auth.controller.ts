import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { JWT_SECRET, jwtOptions, SALT_ROUNDS } from "../utils/jwtConfig";

/* ----------------------------------------------------
   CONSTANTS
---------------------------------------------------- */
const REFRESH_SECRET = process.env.REFRESH_SECRET as string;
const FRONTEND_URL = process.env.FRONTEND_URL as string;
const IS_PROD = process.env.NODE_ENV === "production";

const ACCESS_TOKEN_MAX_AGE = 15 * 60 * 1000;           // 15 minutes
const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

/* ----------------------------------------------------
   HELPERS
---------------------------------------------------- */
const createAccessToken = (user: {
  id: number;
  role: string;
  sellerId: number | null;
}) => {
  return jwt.sign(
    { id: user.id, role: user.role, sellerId: user.sellerId },
    JWT_SECRET,
    jwtOptions // make sure expiresIn is "15m" in jwtConfig
  );
};

const createRefreshToken = (userId: number) => {
  return jwt.sign({ id: userId }, REFRESH_SECRET, { expiresIn: "7d" });
};

const setAuthCookies = (res: Response, accessToken: string, refreshToken: string) => {
  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "strict",
    maxAge: ACCESS_TOKEN_MAX_AGE,
  });

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "strict",
    path: "/api/auth/refresh", // only sent to this route
    maxAge: REFRESH_TOKEN_MAX_AGE,
  });
};

const clearAuthCookies = (res: Response) => {
  res.clearCookie("accessToken");
  res.clearCookie("refreshToken", { path: "/api/auth/refresh" });
};

const validateEmail = (email: string) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const validatePassword = (password: string) => {
  // Min 8 chars, at least 1 uppercase, 1 number, 1 special char
  return /^(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*]).{8,}$/.test(password);
};

/* ----------------------------------------------------
   REGISTER
---------------------------------------------------- */
export const register = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { name, email, password, businessName, phone, role } = req.body;

    // Basic field validation
    if (!name || !email || !password) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Email format validation
    if (!validateEmail(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    // Password strength validation
    if (!validatePassword(password)) {
      return res.status(400).json({
        message:
          "Password must be at least 8 characters and include an uppercase letter, a number, and a special character (!@#$%^&*)",
      });
    }

    const userRole = (role || "SELLER").toUpperCase();

    if (!["ADMIN", "SELLER"].includes(userRole)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    if (userRole === "SELLER" && (!businessName || !phone)) {
      return res
        .status(400)
        .json({ message: "Business name & phone required for sellers" });
    }

    const existing = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existing) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const hashed = await bcrypt.hash(password, SALT_ROUNDS);

    let seller = null;
    if (userRole === "SELLER") {
      seller = await prisma.seller.create({
        data: { businessName, phone },
      });
    }

    const user = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        password: hashed,
        role: userRole,
        sellerId: seller?.id ?? null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        sellerId: true,
        createdAt: true,
      },
    });

    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user.id);
    setAuthCookies(res, accessToken, refreshToken);

    return res.status(201).json({
      message: "Registration successful",
      user,
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   LOGIN
---------------------------------------------------- */
export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: {
        id: true,
        email: true,
        name: true,
        password: true,
        role: true,
        sellerId: true,
        authProvider: true,
      },
    });

    // Use generic message to prevent user enumeration
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Social login users cannot use password login
    if (!user.password || user.authProvider !== "LOCAL") {
      return res.status(400).json({
        message:
          "This account uses social login. Please sign in with Google or Facebook.",
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user.id);
    setAuthCookies(res, accessToken, refreshToken);

    return res.status(200).json({
      message: "Login successful",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        sellerId: user.sellerId,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   REFRESH TOKEN
---------------------------------------------------- */
export const refreshToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.cookies?.refreshToken;

    if (!token) {
      return res.status(401).json({ message: "No refresh token provided" });
    }

    let decoded: { id: number };
    try {
      decoded = jwt.verify(token, REFRESH_SECRET) as { id: number };
    } catch {
      clearAuthCookies(res);
      return res.status(401).json({ message: "Invalid or expired refresh token" });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, role: true, sellerId: true },
    });

    if (!user) {
      clearAuthCookies(res);
      return res.status(401).json({ message: "User not found" });
    }

    const newAccessToken = createAccessToken(user);

    res.cookie("accessToken", newAccessToken, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: "strict",
      maxAge: ACCESS_TOKEN_MAX_AGE,
    });

    return res.status(200).json({ message: "Token refreshed" });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   LOGOUT
---------------------------------------------------- */
export const logout = async (_req: AuthRequest, res: Response) => {
  clearAuthCookies(res);
  return res.status(200).json({ message: "Logged out successfully" });
};

/* ----------------------------------------------------
   FORGOT PASSWORD
---------------------------------------------------- */
export const forgotPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email } = req.body;

    // Always return the same message to prevent email enumeration
    const genericResponse = {
      message: "If that email exists, a reset link has been sent.",
    };

    if (!email || !validateEmail(email)) {
      return res.status(200).json(genericResponse);
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      return res.status(200).json(genericResponse);
    }

    // Invalidate any existing reset tokens for this user
    await prisma.passwordReset.deleteMany({
      where: { userId: user.id },
    });

    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 1000 * 60 * 30); // 30 min

    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        token,
        expiresAt: expires,
      },
    });

    // TODO: Replace with real email service (e.g. Resend, SendGrid, Nodemailer)
    const resetLink = `${FRONTEND_URL}/reset-password/${token}`;
    console.log(`[DEV] Reset link for ${user.email}: ${resetLink}`);

    return res.status(200).json(genericResponse);
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   GET PROFILE
---------------------------------------------------- */
export const getProfile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        sellerId: true,
        authProvider: true,
        createdAt: true,
        seller: true,
        // ❌ password intentionally excluded
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json(user);
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   UPDATE PROFILE
---------------------------------------------------- */
export const updateProfile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { name, password } = req.body;

    // Nothing to update
    if (!name && !password) {
      return res.status(400).json({ message: "No fields provided to update" });
    }

    const data: { name?: string; password?: string } = {};

    if (name) {
      if (typeof name !== "string" || name.trim().length < 2) {
        return res.status(400).json({ message: "Name must be at least 2 characters" });
      }
      data.name = name.trim();
    }

    if (password) {
      if (!validatePassword(password)) {
        return res.status(400).json({
          message:
            "Password must be at least 8 characters and include an uppercase letter, a number, and a special character",
        });
      }
      data.password = await bcrypt.hash(password, SALT_ROUNDS);
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        sellerId: true,
        // ❌ password intentionally excluded
      },
    });

    return res.status(200).json({ message: "Profile updated", user });
  } catch (err) {
    next(err);
  }
};