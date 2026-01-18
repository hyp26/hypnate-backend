import { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import prisma from "../prisma/client";
import { SALT_ROUNDS } from "../utils/jwtConfig";

const FRONTEND_URL = process.env.FRONTEND_URL!;

// POST /api/auth/forgot-password
export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  // Always return success (security best practice)
  if (!user) {
    return res.json({ message: "If the email exists, a reset link has been sent." });
  }

  // OAuth users cannot reset password
  if (!user.password) {
    return res.json({
      message: "This account uses social login. Please sign in with Google or Facebook.",
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 30); // 30 minutes

  await (prisma as any).passwordReset.create({
    data: {
      userId: user.id,
      token,
      expiresAt,
    },
  });

  const resetLink = `${FRONTEND_URL}/reset-password/${token}`;

  // TODO: replace with real email provider
  console.log("🔐 Password reset link:", resetLink);

  return res.json({ message: "Password reset link sent" });
};

// POST /api/auth/reset-password/:token
export const resetPassword = async (req: Request, res: Response) => {
  const { token } = req.params;
  const { password } = req.body;

  if (!password || password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  const record = await (prisma as any).passwordReset.findUnique({
    where: { token },
    include: { user: true },
  });

  if (!record || record.expiresAt < new Date()) {
    return res.status(400).json({ message: "Invalid or expired token" });
  }

  const hashed = await bcrypt.hash(password, SALT_ROUNDS);

  await prisma.user.update({
    where: { id: record.userId },
    data: { password: hashed },
  });

  await (prisma as any).passwordReset.delete({
    where: { id: record.id },
  });

  return res.json({ message: "Password reset successful" });
};
