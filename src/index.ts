import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

// Routes
import productRoutes from "./routes/product.routes";
import uploadRoutes from "./routes/upload.routes";
import orderRoutes from "./routes/order.routes";
import authRoutes from "./routes/auth.routes";
import analyticsRoutes from "./routes/analytics.routes";
import custumerRoutes from "./routes/customer.routes";
import hypnatexRoutes from "./routes/hypnatex.routes";
import hypnatexInternalRoutes from "./routes/hypnatex.internal.routes"; // ✅ single import

// Middleware
import errorHandler from "./middleware/errorHandler";

const app = express();

/* ---------------- SECURITY ---------------- */

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://hypnate-frontend.onrender.com",
      "https://hypnate.in",
      "https://www.hypnate.in",
    ],
    credentials: true,
  })
);

app.use(helmet());
app.use(cookieParser()); // ✅ required for httpOnly cookie auth
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

/* ---------------- RATE LIMITING ---------------- */

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);

/* ---------------- ROUTES ---------------- */

app.use(
  "/api/products/upload",
  rateLimit({ windowMs: 60 * 1000, max: 20 }),
  uploadRoutes
);

app.use("/api/products", productRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/customers", custumerRoutes);
app.use("/api/hypnate-x/internal", hypnatexInternalRoutes); // ✅ internal BEFORE general
app.use("/api/hypnate-x", hypnatexRoutes);

app.use("/uploads", express.static(path.join(__dirname, "../uploads")));
app.get("/api/health", (_, res) => res.json({ status: "ok" }));
app.use(errorHandler);

/* ---------------- SERVER ---------------- */

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});