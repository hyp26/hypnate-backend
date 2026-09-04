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

/* ----------------------------------------------------
   CONSTANTS
---------------------------------------------------- */
const REFRESH_SECRET = process.env.REFRESH_SECRET as string;
const FRONTEND_URL = process.env.FRONTEND_URL as string;
const IS_PROD = process.env.NODE_ENV === "production";

const ACCESS_TOKEN_MAX_AGE = 15 * 60 * 1000;
const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const VERIFICATION_TOKEN_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

const resend = new Resend(process.env.RESEND_API_KEY);

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

const createRefreshToken = (userId: number) =>
  jwt.sign({ id: userId }, REFRESH_SECRET, { expiresIn: "7d" });

const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: IS_PROD,
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
  res.clearCookie("accessToken", { path: "/" });
  res.clearCookie("refreshToken", {
    path: "/api/auth/refresh",
  });
};

const validateEmail = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Shared by register() and resendVerification() so the template only
// lives in one place.
const sendVerificationEmail = async (
  to: string,
  name: string,
  token: string
) => {
  const verifyUrl = `${FRONTEND_URL}/verify-email?token=${token}`;

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
    const { name, email, password, businessName, phone } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({
        message: "Missing required fields",
      });

    if (!validateEmail(email))
      return res.status(400).json({
        message: "Invalid email format",
      });

    if (!validatePassword(password))
      return res.status(400).json({
        message:
          "Password must be at least 8 characters and include an uppercase letter, a number, and a special character (!@#$%^&*)",
      });

    // SECURITY:
    // The public registration endpoint can ONLY create SELLER accounts.
    // ADMIN accounts must never be created through this endpoint.
    const userRole = "SELLER";

    if (!businessName || !phone)
      return res.status(400).json({
        message: "Business name & phone required for sellers",
      });

    const existing = await prisma.user.findUnique({
      where: {
        email: email.toLowerCase(),
      },
    });

    if (existing)
      return res.status(409).json({
        message: "Email already registered",
      });

    const hashed = await bcrypt.hash(password, SALT_ROUNDS);

    let seller = null;

    seller = await prisma.seller.create({
      data: {
        businessName,
        phone,
      },
    });

    // Generate the verification token up front so it can be written in
    // the same create() call as the rest of the user record.
    const verificationToken = crypto.randomBytes(32).toString("hex");

    const verificationTokenExpiry = new Date(
      Date.now() + VERIFICATION_TOKEN_MAX_AGE
    );

    const user = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        password: hashed,

        // SECURITY:
        // Hardcoded SELLER. Never use a client-supplied role here.
        role: "SELLER",

        sellerId: seller.id,
        verificationToken,
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

    // Fire the verification email. If Resend throws, we still want the
    // account to exist and the person to be logged in — they can hit
    // "resend" from the verify-email screen.
    try {
      await sendVerificationEmail(
        user.email,
        user.name,
        verificationToken
      );
    } catch (emailErr) {
      logger.error("Failed to send verification email", emailErr);
    }

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
   VERIFY EMAIL
---------------------------------------------------- */
export const verifyEmail = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { token } = req.body;

    if (!token)
      return res.status(400).json({
        message: "Verification token is required",
      });

    const existing = await prisma.user.findUnique({
      where: {
        verificationToken: token,
      },
    });

    if (!existing)
      return res.status(400).json({
        message: "This verification link is invalid or has expired.",
      });

    if (
      existing.verificationTokenExpiry &&
      existing.verificationTokenExpiry < new Date()
    )
      return res.status(400).json({
        message:
          "This verification link has expired. Please request a new one.",
      });

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

    // Log this browser in too — the link is usually opened in a different
    // browser/device than the one the person signed up on.
    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user.id);

    setAuthCookies(res, accessToken, refreshToken);

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

    if (!email || !validateEmail(email))
      return res.status(200).json(genericResponse);

    const user = await prisma.user.findUnique({
      where: {
        email: email.toLowerCase(),
      },
    });

    if (!user)
      return res.status(200).json(genericResponse);

    if (user.emailVerified)
      return res.status(200).json({
        message: "This email is already verified.",
      });

    const verificationToken = crypto.randomBytes(32).toString("hex");

    const verificationTokenExpiry = new Date(
      Date.now() + VERIFICATION_TOKEN_MAX_AGE
    );

    await prisma.user.update({
      where: {
        id: user.id,
      },

      data: {
        verificationToken,
        verificationTokenExpiry,
      },
    });

    await sendVerificationEmail(
      user.email,
      user.name,
      verificationToken
    );

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

    if (!email || !password)
      return res.status(400).json({
        message: "Email and password required",
      });

    if (!validateEmail(email))
      return res.status(400).json({
        message: "Invalid email format",
      });

    const user = await prisma.user.findUnique({
      where: {
        email: email.toLowerCase(),
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

    if (!user)
      return res.status(401).json({
        message: "Invalid email or password",
      });

    if (!user.password || user.authProvider !== "LOCAL")
      return res.status(400).json({
        message:
          "This account uses social login. Please sign in with Google or Facebook.",
      });

    const isPasswordValid = await bcrypt.compare(
      password,
      user.password
    );

    if (!isPasswordValid)
      return res.status(401).json({
        message: "Invalid email or password",
      });

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
export const refreshToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.cookies?.refreshToken;

    if (!token)
      return res.status(401).json({
        message: "No refresh token provided",
      });

    let decoded: { id: number };

    try {
      decoded = jwt.verify(
        token,
        REFRESH_SECRET
      ) as { id: number };
    } catch {
      clearAuthCookies(res);

      return res.status(401).json({
        message: "Invalid or expired refresh token",
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
      },
    });

    if (!user) {
      clearAuthCookies(res);

      return res.status(401).json({
        message: "User not found",
      });
    }

    const newAccessToken = createAccessToken(user);

    res.cookie("accessToken", newAccessToken, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: "strict",
      maxAge: ACCESS_TOKEN_MAX_AGE,
    });

    return res.status(200).json({
      message: "Token refreshed",
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   LOGOUT
---------------------------------------------------- */
export const logout = async (
  _req: AuthRequest,
  res: Response
) => {
  clearAuthCookies(res);

  return res.status(200).json({
    message: "Logged out successfully",
  });
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

    const genericResponse = {
      message:
        "If that email exists, a reset link has been sent.",
    };

    if (!email || !validateEmail(email))
      return res.status(200).json(genericResponse);

    const user = await prisma.user.findUnique({
      where: {
        email: email.toLowerCase(),
      },
    });

    if (!user)
      return res.status(200).json(genericResponse);

    // Invalidate existing tokens
    await prisma.passwordReset.deleteMany({
      where: {
        userId: user.id,
      },
    });

    const token = crypto.randomBytes(32).toString("hex");

    const expires = new Date(
      Date.now() + 1000 * 60 * 30
    ); // 30 min

    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        token,
        expiresAt: expires,
      },
    });

    // Send reset email via Resend
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
    if (!req.user?.id)
      return res.status(401).json({
        message: "Unauthorized",
      });

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

        // password intentionally excluded
      },
    });

    if (!user)
      return res.status(404).json({
        message: "User not found",
      });

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
    if (!req.user?.id)
      return res.status(401).json({
        message: "Unauthorized",
      });

    const { name, password } = req.body;

    if (!name && !password)
      return res.status(400).json({
        message: "No fields provided to update",
      });

    const data: {
      name?: string;
      password?: string;
    } = {};

    if (name) {
      if (
        typeof name !== "string" ||
        name.trim().length < 2
      )
        return res.status(400).json({
          message: "Name must be at least 2 characters",
        });

      data.name = name.trim();
    }

    if (password) {
      if (!validatePassword(password))
        return res.status(400).json({
          message:
            "Password must be at least 8 characters and include an uppercase letter, a number, and a special character",
        });

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

        // password intentionally excluded
      },
    });

    return res.status(200).json({
      message: "Profile updated",
      user,
    });
  } catch (err) {
    next(err);
  }
};