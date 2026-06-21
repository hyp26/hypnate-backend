import { Request, Response } from "express";
import bcrypt from "bcrypt";
import prisma from "../prisma/client";
import { SALT_ROUNDS } from "../utils/jwtConfig";
import { validatePassword } from "../utils/password";

export const resetPassword = async (req: Request, res: Response) => {
  const { token } = req.params;
  const { password } = req.body;

  if (typeof password !== "string") {
  return res.status(400).json({ message: "Password is required" });
}

  if (!validatePassword(password)) {
  return res.status(400).json({
    message:
      "Password must be at least 8 characters and include an uppercase letter, a number, and a special character",
  });
}

  const record = await prisma.passwordReset.findUnique({
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

  await prisma.passwordReset.delete({
    where: { id: record.id },
  });

  return res.json({ message: "Password reset successful" });
};
