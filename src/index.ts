import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import path from "path";

// Routes
import productRoutes from "./routes/product.routes";
import uploadRoutes from "./routes/upload.routes";
import orderRoutes from "./routes/order.routes";
import authRoutes from "./routes/auth.routes";
import analyticsRoutes from "./routes/analytics.routes";

// Middleware
import errorHandler from "./middleware/errorHandler";

console.log("App starting...");

// Load environment variables
dotenv.config();

const app = express();

// Security & system middleware
app.use(
  cors({
    origin: [
      "https://hypnate-frontend.onrender.com",
      "https://hypnate.in",
      "https://www.hypnate.in"
],
    credentials: true,
  })
);

app.use(helmet());
app.disable("x-powered-by");

app.use(express.json({ limit: "2mb" }));

// ----------------------------
// ROUTES (UPLOAD FIRST!)
// ----------------------------

// Image Upload Route (multipart/form-data)
app.use(
  "/api/products/upload",
  rateLimit({
    windowMs: 60 * 1000,
    max: 20,
  }),
  uploadRoutes
);

// Product CRUD (JSON only)
app.use("/api/products", productRoutes);

// Authentication
app.use("/api/auth", authRoutes);

// Orders
app.use("/api/orders", orderRoutes);

// Analytics
app.use("/api/analytics", analyticsRoutes);

// Static file serving (local uploads if used)
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Health check
app.get("/api/health", (_, res) => res.json({ status: "ok" }));

// Global error handler
app.use(errorHandler);

// ----------------------------
// SERVER START
// ----------------------------
const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
