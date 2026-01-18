import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import path from "path";
import passport from "passport";

// Load env first
dotenv.config();

// Routes
import categoryRoutes from "./routes/category.routes";
import productRoutes from "./routes/product.routes";
import uploadRoutes from "./routes/upload.routes";
import orderRoutes from "./routes/order.routes";
import authRoutes from "./routes/auth.routes";
import analyticsRoutes from "./routes/analytics.routes";

// Passport strategies
import "./auth/passport";

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

app.use(passport.initialize());
app.use(helmet());
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

/* ---------------- ROUTES ---------------- */

// Uploads (rate limited)
app.use(
  "/api/products/upload",
  rateLimit({
    windowMs: 60 * 1000,
    max: 20,
  }),
  uploadRoutes
);

// Core APIs
app.use("/api/categories", categoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/analytics", analyticsRoutes);

// Static uploads (if local)
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Health check
app.get("/api/health", (_, res) => res.json({ status: "ok" }));

// Global error handler
app.use(errorHandler);

/* ---------------- SERVER ---------------- */

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
