import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import prisma from "../../prisma/client";
import {
  AdminAuthRequest,
  ADMIN_REFRESH_COOKIE,
  ADMIN_REFRESH_TOKEN_MAX_AGE,
  clearAdminAuthCookies,
  createAdminAccessToken,
  createAdminRefreshToken,
  hashAdminToken,
  setAdminAuthCookies,
} from "../../middleware/adminAuth.middleware";
import {
  adminChangePasswordSchema,
  adminLoginSchema,
} from "../../schemas/admin.schemas";
import { recordAudit } from "../../services/adminAudit.service";
import { validatePassword } from "../../utils/password";

/* ----------------------------------------------------
   HELPERS
---------------------------------------------------- */

const publicAdmin = (admin: {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  avatarUrl: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}) => ({
  id: admin.id,
  email: admin.email,
  firstName: admin.firstName,
  lastName: admin.lastName,
  role: admin.role,
  status: admin.status,
  avatar: admin.avatarUrl ?? "",
  lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
  createdAt: admin.createdAt.toISOString(),
});

const createSession = async (adminUserId: number, refreshToken: string) => {
  return prisma.adminSession.create({
    data: {
      adminUserId,
      tokenHash: hashAdminToken(refreshToken),
      expiresAt: new Date(Date.now() + ADMIN_REFRESH_TOKEN_MAX_AGE),
    },
  });
};

const revokeAllSessions = async (adminUserId: number) => {
  await prisma.adminSession.updateMany({
    where: {
      adminUserId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
};

/* ----------------------------------------------------
   POST /api/admin/auth/login
---------------------------------------------------- */

export const adminLogin = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = adminLoginSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const { email, password } = parsed.data;

    const admin = await prisma.adminUser.findUnique({
      where: { email },
    });

    // Uniform error: never reveal whether the account exists.
    if (
      !admin ||
      !admin.passwordHash ||
      !(await bcrypt.compare(password, admin.passwordHash))
    ) {
      res.status(401).json({ message: "Invalid admin credentials" });
      return;
    }

    if (admin.status !== "ACTIVE") {
      res.status(403).json({
        message: "Admin account is inactive or suspended",
      });
      return;
    }

    const accessToken = createAdminAccessToken({
      id: admin.id,
      role: admin.role,
    });

    const refreshToken = createAdminRefreshToken();
    await createSession(admin.id, refreshToken);

    const updated = await prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    setAdminAuthCookies(res, accessToken, refreshToken);

    await recordAudit({
      actorId: admin.id,
      action: "LOGIN",
      entityType: "AdminUser",
      entityId: admin.id,
      req,
    });

    res.json({
      admin: publicAdmin({ ...admin, lastLoginAt: updated.lastLoginAt }),
      accessToken,
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   POST /api/admin/auth/refresh
---------------------------------------------------- */

export const adminRefresh = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const rawToken = req.cookies?.[ADMIN_REFRESH_COOKIE];

    if (typeof rawToken !== "string" || !rawToken.trim()) {
      res.status(401).json({ message: "Admin refresh token required" });
      return;
    }

    const session = await prisma.adminSession.findUnique({
      where: { tokenHash: hashAdminToken(rawToken) },
      include: { adminUser: true },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt < new Date() ||
      session.adminUser.status !== "ACTIVE"
    ) {
      res
        .status(401)
        .json({ message: "Invalid or expired admin refresh token" });
      return;
    }

    const accessToken = createAdminAccessToken({
      id: session.adminUser.id,
      role: session.adminUser.role,
    });

    setAdminAuthCookies(res, accessToken, rawToken);

    res.json({
      admin: publicAdmin(session.adminUser),
      accessToken,
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   POST /api/admin/auth/logout
---------------------------------------------------- */

export const adminLogout = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const rawToken = req.cookies?.[ADMIN_REFRESH_COOKIE];

    if (typeof rawToken === "string" && rawToken.trim()) {
      await prisma.adminSession.updateMany({
        where: {
          tokenHash: hashAdminToken(rawToken),
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    }

    clearAdminAuthCookies(res);

    await recordAudit({
      actorId: req.adminUser?.id ?? null,
      action: "LOGOUT",
      entityType: "AdminUser",
      entityId: req.adminUser?.id,
      req,
    });

    res.json({ message: "Logged out" });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   GET /api/admin/auth/profile
---------------------------------------------------- */

export const adminProfile = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.adminUser!.id },
    });

    if (!admin) {
      res.status(404).json({ message: "Admin account not found" });
      return;
    }

    res.json({ admin: publicAdmin(admin) });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   POST /api/admin/auth/change-password
---------------------------------------------------- */

export const adminChangePassword = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = adminChangePasswordSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const { currentPassword, newPassword } = parsed.data;

    if (!validatePassword(newPassword)) {
      res.status(400).json({
        message:
          "New password must contain an uppercase letter, a number and a special character",
      });
      return;
    }

    const admin = await prisma.adminUser.findUnique({
      where: { id: req.adminUser!.id },
    });

    if (!admin || !admin.passwordHash) {
      res.status(404).json({ message: "Admin account not found" });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, admin.passwordHash);

    if (!valid) {
      res.status(401).json({ message: "Current password is incorrect" });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { passwordHash },
    });

    // Invalidate every existing session after a password change.
    await revokeAllSessions(admin.id);

    await recordAudit({
      actorId: admin.id,
      action: "SETTINGS",
      entityType: "AdminUser",
      entityId: admin.id,
      newValue: { passwordChanged: true },
      req,
    });

    clearAdminAuthCookies(res);

    res.json({ message: "Password updated. Please log in again." });
  } catch (err) {
    next(err);
  }
};
