import { Request, Response } from "express";
import bcrypt from "bcrypt";
import prisma from "../prisma/client";
import { SALT_ROUNDS } from "../utils/jwtConfig";
import { validatePassword } from "../utils/password";
import { hashToken } from "../utils/tokenHash";

export const resetPassword = async (req: Request, res: Response) => {
  const { token } = req.params;
  const { password } = req.body;

  if (typeof token !== "string" || !token) {
    return res.status(400).json({
      message: "Reset token is required",
    });
  }

  if (typeof password !== "string") {
    return res.status(400).json({
      message: "Password is required",
    });
  }

  if (!validatePassword(password)) {
    return res.status(400).json({
      message:
        "Password must be at least 8 characters and include an uppercase letter, a number, and a special character",
    });
  }

  const tokenHash = hashToken(token);

  const record = await prisma.passwordReset.findUnique({
    where: {
      token: tokenHash,
    },
  });

  if (!record || record.expiresAt < new Date()) {
    return res.status(400).json({
      message: "Invalid or expired token",
    });
  }

  const hashedPassword = await bcrypt.hash(
    password,
    SALT_ROUNDS
  );

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: {
        id: record.userId,
      },
      data: {
        password: hashedPassword,
      },
    });

    // Password reset invalidates every existing refresh session.
    await tx.refreshSession.updateMany({
      where: {
        userId: record.userId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    // Reset tokens are single-use.
    await tx.passwordReset.delete({
      where: {
        id: record.id,
      },
    });

    // Invalidate any other outstanding reset tokens for this account.
    await tx.passwordReset.deleteMany({
      where: {
        userId: record.userId,
      },
    });
  });

  return res.json({
    message: "Password reset successful",
  });
};