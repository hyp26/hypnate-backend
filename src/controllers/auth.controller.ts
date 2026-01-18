import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { JWT_SECRET, jwtOptions, SALT_ROUNDS } from "../utils/jwtConfig";

/* ----------------------------------------------------
   HELPER
---------------------------------------------------- */
const createToken = (user: {
  id: number;
  role: string;
  sellerId: number | null;
}) => {
  return jwt.sign(
    { id: user.id, role: user.role, sellerId: user.sellerId },
    JWT_SECRET,
    jwtOptions
  );
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

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const userRole = (role || "SELLER").toUpperCase();

    if (userRole === "SELLER" && (!businessName || !phone)) {
      return res
        .status(400)
        .json({ message: "Business name & phone required" });
    }

    const existing = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existing) {
      return res.status(409).json({ message: "Email already exists" });
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
    });

    const token = createToken(user);

    res.status(201).json({ token, user });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   LOGIN
---------------------------------------------------- */
export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: {
        id: true,
        email: true,
        password: true,
        role: true,
        sellerId: true,
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 🚨 IMPORTANT FIX (social login users)
    if (!user.password) {
      return res.status(400).json({
        message: "This account uses social login. Please sign in with Google or Facebook.",
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(400).json({ message: "Incorrect password" });
    }

    const token = createToken(user);

    return res.status(200).json({
      message: "Login successful",
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        sellerId: user.sellerId,
      },
      token,
    });
  } catch (error) {
    next(error);
  }
};

/* ----------------------------------------------------
   FORGOT PASSWORD
---------------------------------------------------- */

export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) {
    return res.status(200).json({ message: "If email exists, link sent" });
  }

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!user) {
    return res.status(200).json({ message: "If email exists, link sent" });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 1000 * 60 * 30); // 30 min

  await (prisma as any).passwordReset.create({
    data: {
      userId: user.id,
      token,
      expiresAt: expires,
    },
  });

  // TODO: send email here
  console.log(`Reset link: ${process.env.FRONTEND_URL}/reset-password/${token}`);

  return res.json({ message: "If email exists, link sent" });
};


/* ----------------------------------------------------
   PROFILE
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
      include: { seller: true },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
};

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

    const data: any = {};
    if (name) data.name = name;
    if (password) data.password = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
};

export const logout = async (_req: AuthRequest, res: Response) => {
  res.json({ message: "Logged out" });
};
