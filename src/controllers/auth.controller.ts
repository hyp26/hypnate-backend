import { Request, Response, NextFunction, CookieOptions } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { JWT_SECRET, jwtOptions, SALT_ROUNDS } from "../utils/jwtConfig";
import { validatePassword } from "../utils/password";
import { logger } from "../utils/logger";
import { hashToken } from "../utils/tokenHash";
import { ENV } from "../config/env";

/* ----------------------------------------------------
   CONSTANTS
---------------------------------------------------- */

const REFRESH_SECRET = ENV.REFRESH_SECRET;
const FRONTEND_URL = ENV.FRONTEND_URL;
const IS_PROD = ENV.NODE_ENV === "production";

const ACCESS_TOKEN_MAX_AGE = 15 * 60 * 1000;
const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const VERIFICATION_TOKEN_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

const resend = new Resend(ENV.RESEND_API_KEY);

/* ----------------------------------------------------
   HELPERS
---------------------------------------------------- */

const createAccessToken = (user: {
  id: number;
  role: string;
  sellerId: number | null;
}) =>
  jwt.sign(
    {
      id: user.id,
      role: user.role,
      sellerId: user.sellerId,
    },
    JWT_SECRET,
    jwtOptions
  );

/**
 * Creates a cryptographically random refresh token.
 *
 * The raw token is returned only so it can be sent to the
 * browser as an HttpOnly cookie. Only its SHA-256 hash is
 * persisted in the database.
 */
const createRefreshToken = (userId: number): string => {
  const jti = crypto.randomUUID();

  return jwt.sign(
    {
      id: userId,
      jti,
    },
    REFRESH_SECRET,
    {
      expiresIn: "7d",
    }
  );
};

/**
 * Hash the refresh token before storing or looking it up.
 *
 * The database must never contain the raw refresh token.
 */
const hashRefreshToken = (token: string): string =>
  crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

/**
 * Create a persistent refresh session for a user.
 */
const createRefreshSession = async (
  userId: number,
  refreshToken: string
) => {
  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_MAX_AGE
  );

  return prisma.refreshSession.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt,
    },
  });
};

/**
 * Revoke every active refresh session belonging to a user.
 *
 * Exported so password-reset logic can invalidate all existing
 * sessions after a password change.
 */
export const revokeAllRefreshSessions = async (
  userId: number
) => {
  await prisma.refreshSession.updateMany({
    where: {
      userId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
};

/**
 * Revoke exactly one refresh session.
 */
export const revokeRefreshSession = async (
  token: string
) => {
  await prisma.refreshSession.updateMany({
    where: {
      tokenHash: hashRefreshToken(token),
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
};

/* ----------------------------------------------------
   COOKIES
---------------------------------------------------- */

const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: IS_PROD,
  // Frontend and API are deployed on different sites in production
  // (e.g. hypnate.in -> the Render API), so browser auth cookies must
  // explicitly allow cross-site XHR/fetch requests.
  sameSite: IS_PROD ? "none" : "lax",
};

const setAuthCookies = (
  res: Response,
  accessToken: string,
  refreshToken: string
) => {
  res.cookie("accessToken", accessToken, {
    ...baseCookieOptions,
    maxAge: ACCESS_TOKEN_MAX_AGE,
    path: "/",
  });

  res.cookie("refreshToken", refreshToken, {
    ...baseCookieOptions,
    maxAge: REFRESH_TOKEN_MAX_AGE,
    path: "/api/auth/refresh",
  });
};

const clearAuthCookies = (res: Response) => {
  res.clearCookie("accessToken", {
    path: "/",
  });

  res.clearCookie("refreshToken", {
    path: "/api/auth/refresh",
  });
};

/* ----------------------------------------------------
   VALIDATION
---------------------------------------------------- */

const validateEmail = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/* ----------------------------------------------------
   EMAIL VERIFICATION EMAIL
---------------------------------------------------- */

/**
 * Shared by register() and resendVerification() so the
 * verification email template only lives in one place.
 */
const sendVerificationEmail = async (
  to: string,
  name: string,
  token: string
) => {
  const verifyUrl =
    `${FRONTEND_URL}/verify-email?token=${token}`;

  await resend.emails.send({
    from: "Hypnate <noreply@hypnate.in>",
    to,
    subject: "Verify your Hypnate account",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#111">Hi ${name || "there"},</h2>

        <p style="color:#555">
          Thanks for signing up for Hypnate. Click the button below to verify
          your email and activate your account.
        </p>

        <a href="${verifyUrl}"
           style="display:inline-block;margin-top:16px;padding:12px 24px;background:#0d9488;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
          Verify my email
        </a>

        <p style="color:#888;font-size:13px;margin-top:24px">
          Or paste this link into your browser:<br />
          <a href="${verifyUrl}" style="color:#0d9488">${verifyUrl}</a>
        </p>

        <p style="color:#888;font-size:12px">
          This link expires in 24 hours.
        </p>
      </div>
    `,
  });
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
    // IMPORTANT:
    // Public registration never accepts a role from the client.
    // Every account created through this endpoint is a SELLER.
    const {
      name,
      email,
      password,
      businessName,
      phone,
      selectedPlan,
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        message: "Missing required fields",
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        message: "Invalid email format",
      });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({
        message:
          "Password must be at least 8 characters and include an uppercase letter, a number, and a special character (!@#$%^&*)",
      });
    }

    // SECURITY:
    // Public registration can ONLY create SELLER accounts.
    // ADMIN accounts must never be created through this endpoint.
    const userRole = "SELLER";

    // Every new merchant receives the same 7-day Starter trial.
    // Older clients may still send selectedPlan; it is intentionally ignored.
    const trialStartedAt = new Date();
    const trialEndsAt = new Date(
      trialStartedAt.getTime() + 7 * 24 * 60 * 60 * 1000
    );
    const trialPlan = "starter";

    if (!businessName || !phone) {
      return res.status(400).json({
        message: "Business name & phone required for sellers",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({
      where: {
        email: normalizedEmail,
      },
    });

    if (existing) {
      return res.status(409).json({
        message: "Email already registered",
      });
    }

    const hashed = await bcrypt.hash(
      password,
      SALT_ROUNDS
    );

    const seller = await prisma.seller.create({
      data: {
        businessName,
        phone,
        selectedPlan: trialPlan,
        trialPlan,
        trialStartedAt,
        trialEndsAt,
      },
    });

    // Generate verification token before creating the user.
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationTokenHash = hashToken(verificationToken);

    const verificationTokenExpiry = new Date(
      Date.now() + VERIFICATION_TOKEN_MAX_AGE
    );

    const user = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        password: hashed,
        role: "SELLER",
        sellerId: seller.id,
        verificationToken: verificationTokenHash,
        verificationTokenExpiry,
      },

      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        sellerId: true,
        emailVerified: true,
        createdAt: true,
        seller: true,
      },
    });

    // Fire the verification email.
    //
    // The account remains valid even if the email provider
    // temporarily fails. The user can use resend verification.
    try {
      await sendVerificationEmail(
        user.email,
        user.name,
        verificationToken
      );
    } catch (emailErr) {
      logger.error(
        "Failed to send verification email",
        emailErr
      );
    }

    /*
     * IMPORTANT:
     *
     * Do NOT issue access/refresh tokens here.
     *
     * Product access begins only after email verification.
     */
    return res.status(201).json({
      message:
        "Registration successful. Please verify your email before logging in.",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        sellerId: user.sellerId,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
        seller: user.seller,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   VERIFY EMAIL
---------------------------------------------------- */

export const verifyEmail = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        message: "Verification token is required",
      });
    }

    const tokenHash = hashToken(token);

    const existing = await prisma.user.findUnique({
      where: {
        verificationToken: tokenHash,
      },
    });

    if (!existing) {
      return res.status(400).json({
        message:
          "This verification link is invalid or has expired.",
      });
    }

    if (
      existing.verificationTokenExpiry &&
      existing.verificationTokenExpiry < new Date()
    ) {
      return res.status(400).json({
        message:
          "This verification link has expired. Please request a new one.",
      });
    }

    const user = await prisma.user.update({
      where: {
        id: existing.id,
      },

      data: {
        emailVerified: true,
        verificationToken: null,
        verificationTokenExpiry: null,
      },

      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        sellerId: true,
        emailVerified: true,
        seller: true,
      },
    });

    /*
     * The verification link can be opened on a different
     * browser/device than registration.
     *
     * Now that the email is verified, we can create the
     * authenticated session.
     */
    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user.id);

    await createRefreshSession(
      user.id,
      refreshToken
    );

    setAuthCookies(
      res,
      accessToken,
      refreshToken
    );

    return res.status(200).json({
      message: "Email verified",
      user,
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   RESEND VERIFICATION
---------------------------------------------------- */

export const resendVerification = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email } = req.body;

    const genericResponse = {
      message:
        "If that email exists, a verification link has been sent.",
    };

    if (
      !email ||
      typeof email !== "string" ||
      !validateEmail(email)
    ) {
      return res.status(200).json(genericResponse);
    }

    const user = await prisma.user.findUnique({
      where: {
        email: email.toLowerCase().trim(),
      },
    });

    if (!user) {
      return res.status(200).json(genericResponse);
    }

    if (user.emailVerified) {
      return res.status(200).json({
        message: "This email is already verified.",
      });
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationTokenHash = hashToken(verificationToken);

    const verificationTokenExpiry = new Date(
      Date.now() + VERIFICATION_TOKEN_MAX_AGE
    );

    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        verificationToken: verificationTokenHash,
        verificationTokenExpiry,
      },
    });

    try {
      await sendVerificationEmail(
        user.email,
        user.name,
        verificationToken
      );
    } catch (emailErr) {
      logger.error(
        "Failed to resend verification email",
        emailErr
      );
    }

    return res.status(200).json(genericResponse);
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
      return res.status(400).json({
        message: "Email and password required",
      });
    }

    if (
      typeof email !== "string" ||
      !validateEmail(email)
    ) {
      return res.status(400).json({
        message: "Invalid email format",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        email: email.toLowerCase().trim(),
      },

      select: {
        id: true,
        email: true,
        name: true,
        password: true,
        role: true,
        sellerId: true,
        authProvider: true,
        emailVerified: true,
        seller: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    if (!user.password || user.authProvider !== "LOCAL") {
      return res.status(400).json({
        message:
          "This account uses social login. Please sign in with Google or Facebook.",
      });
    }

    const isPasswordValid = await bcrypt.compare(
      password,
      user.password
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    /*
     * HYP-002-16:
     *
     * An account must be email-verified before it can
     * receive authenticated product access.
     */
    if (!user.emailVerified) {
      return res.status(403).json({
        message:
          "Please verify your email before logging in.",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(
      user.id
    );

    /*
     * HYP-002-14:
     *
     * Persist the refresh session server-side.
     * Only the hash is stored.
     */
    await createRefreshSession(
      user.id,
      refreshToken
    );

    setAuthCookies(
      res,
      accessToken,
      refreshToken
    );

    return res.status(200).json({
      message: "Login successful",

      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        sellerId: user.sellerId,
        emailVerified: user.emailVerified,
        seller: user.seller,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   REFRESH TOKEN
---------------------------------------------------- */

/**
 * Refresh-token rotation.
 *
 * Every successful refresh:
 *
 * 1. Verifies the presented refresh JWT.
 * 2. Hashes the presented token.
 * 3. Finds its server-side RefreshSession.
 * 4. Rejects revoked/expired sessions.
 * 5. Verifies the user still exists and is verified.
 * 6. Revokes the old refresh session.
 * 7. Creates a completely new refresh token/session.
 * 8. Creates a new access token.
 * 9. Replaces the browser cookies.
 *
 * Therefore a previously-used refresh token cannot be
 * reused after successful rotation.
 */
export const refreshToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.cookies?.refreshToken;

    if (!token || typeof token !== "string") {
      return res.status(401).json({
        message: "No refresh token provided",
      });
    }

    let decoded: {
      id: number;
      jti: string;
    };

    try {
      const payload = jwt.verify(
        token,
        REFRESH_SECRET
      );

      if (
        typeof payload !== "object" ||
        payload === null ||
        typeof payload.id !== "number" ||
        typeof payload.jti !== "string"
      ) {
        clearAuthCookies(res);

        return res.status(401).json({
          message: "Invalid refresh token",
        });
      }

      decoded = {
        id: payload.id,
        jti: payload.jti,
      };
    } catch {
      clearAuthCookies(res);

      return res.status(401).json({
        message: "Invalid or expired refresh token",
      });
    }

    const tokenHash = hashRefreshToken(token);

    /*
     * Look up the server-side session.
     *
     * This is the critical difference from the old
     * implementation: a valid JWT alone is no longer enough.
     */
    const session =
      await prisma.refreshSession.findUnique({
        where: {
          tokenHash,
        },
      });

    if (!session) {
      clearAuthCookies(res);

      return res.status(401).json({
        message:
          "Refresh session is invalid or has been revoked",
      });
    }

    if (session.userId !== decoded.id) {
      clearAuthCookies(res);

      return res.status(401).json({
        message: "Invalid refresh session",
      });
    }

    if (session.revokedAt) {
      clearAuthCookies(res);

      return res.status(401).json({
        message:
          "Refresh session has already been revoked",
      });
    }

    if (session.expiresAt <= new Date()) {
      clearAuthCookies(res);

      return res.status(401).json({
        message: "Refresh session has expired",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: decoded.id,
      },

      select: {
        id: true,
        role: true,
        sellerId: true,
        emailVerified: true,
      },
    });

    if (!user) {
      await revokeRefreshSession(token);

      clearAuthCookies(res);

      return res.status(401).json({
        message: "User not found",
      });
    }

    /*
     * Email verification is a prerequisite for product access.
     *
     * If an account becomes unverified for any reason,
     * its refresh session cannot be used to regain access.
     */
    if (!user.emailVerified) {
      await revokeRefreshSession(token);

      clearAuthCookies(res);

      return res.status(403).json({
        message:
          "Please verify your email before accessing Hypnate.",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    const newAccessToken =
      createAccessToken(user);

    const newRefreshToken =
      createRefreshToken(user.id);

    /*
     * Atomic rotation:
     *
     * The old session must still be active when we revoke it.
     * If another request has already rotated it, updateMany()
     * returns count = 0 and the transaction fails.
     *
     * This prevents the same refresh token from being
     * successfully rotated twice.
     */
    await prisma.$transaction(async (tx) => {
      const revoked =
        await tx.refreshSession.updateMany({
          where: {
            id: session.id,
            revokedAt: null,
          },

          data: {
            revokedAt: new Date(),
          },
        });

      if (revoked.count !== 1) {
        throw new Error(
          "Refresh session was already revoked"
        );
      }

      await tx.refreshSession.create({
        data: {
          userId: user.id,
          tokenHash:
            hashRefreshToken(newRefreshToken),
          expiresAt: new Date(
            Date.now() + REFRESH_TOKEN_MAX_AGE
          ),
        },
      });
    });

    /*
     * Only send the newly-issued refresh token to the
     * browser after the database rotation succeeds.
     */
    setAuthCookies(
      res,
      newAccessToken,
      newRefreshToken
    );

    return res.status(200).json({
      message: "Token refreshed",
    });
  } catch (err) {
    clearAuthCookies(res);
    next(err);
  }
};

/* ----------------------------------------------------
   LOGOUT
---------------------------------------------------- */

export const logout = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const token = req.cookies?.refreshToken;

    if (token && typeof token === "string") {
      await revokeRefreshSession(token);
    }

    clearAuthCookies(res);

    return res.status(200).json({
      message: "Logged out successfully",
    });
  } catch (err) {
    /*
     * Logout should still clear browser credentials even
     * if server-side session revocation encounters an error.
     */
    clearAuthCookies(res);

    logger.error(
      "Logout session revocation failed",
      err
    );

    return res.status(200).json({
      message: "Logged out successfully",
    });
  }
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

    /*
     * Always return the same response for valid/invalid
     * addresses to avoid email-account enumeration.
     */
    const genericResponse = {
      message:
        "If that email exists, a reset link has been sent.",
    };

    if (
      !email ||
      typeof email !== "string" ||
      !validateEmail(email)
    ) {
      return res.status(200).json(genericResponse);
    }

    const user = await prisma.user.findUnique({
      where: {
        email: email.toLowerCase().trim(),
      },
    });

    if (!user) {
      return res.status(200).json(genericResponse);
    }

    // Invalidate existing password-reset tokens.
    await prisma.passwordReset.deleteMany({
      where: {
        userId: user.id,
      },
    });

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);

    const expires = new Date(
      Date.now() + 1000 * 60 * 30
    );

    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        token: tokenHash,
        expiresAt: expires,
      },
    });

    await resend.emails.send({
      from: "Hypnate <noreply@hypnate.in>",
      to: user.email,
      subject: "Reset your Hypnate password",

      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#111">Reset your password</h2>

          <p style="color:#555">
            Click the button below to reset your password.
            This link expires in 30 minutes.
          </p>

          <a href="${FRONTEND_URL}/reset-password/${token}"
             style="display:inline-block;margin-top:16px;padding:12px 24px;background:#0d9488;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
            Reset Password
          </a>

          <p style="color:#888;font-size:13px;margin-top:24px">
            If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      `,
    });

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
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: req.user.id,
      },

      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        sellerId: true,
        authProvider: true,
        createdAt: true,
        emailVerified: true,
        seller: true,

        // Password intentionally excluded.
      },
    });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
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
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const { name, password } = req.body;

    if (!name && !password) {
      return res.status(400).json({
        message: "No fields provided to update",
      });
    }

    const data: {
      name?: string;
      password?: string;
    } = {};

    if (name) {
      if (
        typeof name !== "string" ||
        name.trim().length < 2
      ) {
        return res.status(400).json({
          message: "Name must be at least 2 characters",
        });
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

      data.password = await bcrypt.hash(
        password,
        SALT_ROUNDS
      );
    }

    const user = await prisma.user.update({
      where: {
        id: req.user.id,
      },

      data,

      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        sellerId: true,

      },
    });

  
    if (data.password) {
      await revokeAllRefreshSessions(req.user.id);

      clearAuthCookies(res);
    }

    return res.status(200).json({
      message: "Profile updated",
      user,
    });
  } catch (err) {
    next(err);
  }
};