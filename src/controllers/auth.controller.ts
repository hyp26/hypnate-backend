import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken"; // missing import in your version
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { jwtOptions, JWT_SECRET, SALT_ROUNDS } from "../utils/jwtConfig";

// ===============================
// User Registration
// ===============================
export const register = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, password, businessName, phone, role } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email, and password are required" });
    }

    const userRole = role ? role.toUpperCase() : "SELLER";

    // only require business info for SELLER role
    if (userRole === "SELLER" && (!businessName || !phone)) {
      return res.status(400).json({ message: "Business name and phone are required for sellers" });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (existingUser) {
      return res.status(400).json({ message: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

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
        password: hashedPassword,
        role: userRole,
        sellerId: seller?.id ?? null,
      },
    });

    const payload = { id: user.id, role: user.role };
    const token = jwt.sign(payload, JWT_SECRET, jwtOptions);

    res.status(201).json({
      message: "User registered successfully",
      user: { id: user.id, email: user.email, role: user.role },
      token,
    });
  } catch (error) {
    next(error);
  }
};

// ===============================
// User Login
// ===============================
export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ message: "Incorrect password" });
    }

    const payload = { id: user.id, role: user.role };
    const token = jwt.sign(payload, JWT_SECRET, jwtOptions);

    res.status(200).json({
      message: "Login successful",
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      token,
    });
  } catch (error) {
    next(error);
  }
};

// ===============================
// Get User Profile
// ===============================
export const getProfile = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { seller: true }, // adjust case to match your schema
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      seller: user.seller, // must match include above
    });
  } catch (error) {
    next(error);
  }
};

// ===============================
// Update User Profile
// ===============================

export const updateProfile = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, password, businessName, phone } = req.body;

    const updates: any = {};
    if (name) updates.name = name;
    if (password) updates.password = await bcrypt.hash(password, 10);

    const user = await prisma.user.update({
      where: { id: req.user?.id },
      data: updates,
      include: { seller: true },
    });

    // Update seller table if provided
    if (businessName || phone) {
      await prisma.seller.update({
        where: { id: user.sellerId! },
        data: { businessName, phone },
      });
    }

    const refreshed = await prisma.user.findUnique({
      where: { id: req.user?.id },
      include: { seller: true },
    });

    res.json({
      message: "Profile updated successfully",
      user: refreshed,
    });
  } catch (err) {
    next(err);
  }
};

// ===============================
// logout User
// ===============================
export const logout = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // Invalidate the token (implementation depends on your token strategy)
    res.json({ message: "Logout successful" });
  } catch (error) {
    next(error);
  }
};
