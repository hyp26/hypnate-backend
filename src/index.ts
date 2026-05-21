import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import path from "path";

// 🔥 NEW
import { createServer } from "http";
import { Server } from "socket.io";

dotenv.config();

// Routes
import dashboardRoutes from "./routes/dashboard.routes";
import productRoutes from "./routes/product.routes";
import uploadRoutes from "./routes/upload.routes";
import orderRoutes from "./routes/order.routes";
import authRoutes from "./routes/auth.routes";
import analyticsRoutes from "./routes/analytics.routes";
import customerRoutes from "./routes/customer.routes";
import notificationRoutes, { searchRouter } from "./routes/notification.routes";
import conversationRoutes from "./routes/conversation.routes";
import hypnatexRoutes from "./routes/hypnatex.routes";
import hypnatexInternalRoutes from "./routes/hypnatex.internal.routes";
import onboardingRoutes from "./routes/onboarding.routes";
import paymentRoutes from "./routes/payment.routes";
import waitlistRoutes from "./routes/waitlist.routes";
import channelRoutes from "./routes/channel.routes";

// Webhooks
import telegramWebhookRoutes from "./routes/webhook/telegram";
import messageRoutes from "./routes/webhook/message.routes";

// Middleware
import errorHandler from "./middleware/errorHandler";

const app = express();

/* ---------------- TRUST PROXY ---------------- */
app.set("trust proxy", 1);

/* ---------------- CORS ---------------- */
const allowedOrigins = [
  "http://localhost:3000",
  "https://hypnate-frontend.onrender.com",
  "https://hypnate.in",
  "https://www.hypnate.in",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});

/* ---------------- SECURITY ---------------- */
app.use(helmet());
app.disable("x-powered-by");

/* ---------------- PARSERS ---------------- */
app.use(cookieParser());
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

app.use("/api/dashboard", dashboardRoutes);
app.use("/api/products", productRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/search", searchRouter);
app.use("/api/conversations", conversationRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/waitlist", waitlistRoutes);
app.use("/api/channels", channelRoutes);

// IMPORTANT: internal BEFORE public
app.use("/api/hypnate-x/internal", hypnatexInternalRoutes);
app.use("/api/hypnate-x", hypnatexRoutes);

app.use("/api/onboarding", onboardingRoutes);

/* ---------------- WEBHOOKS ---------------- */
app.use("/api/webhooks", telegramWebhookRoutes);
app.use("/api/messages", messageRoutes);

/* ---------------- STATIC ---------------- */
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

/* ---------------- HEALTH ---------------- */
app.get("/api/health", (_, res) => res.json({ status: "ok" }));

/* ---------------- ERROR HANDLER ---------------- */
app.use(errorHandler);

/* ---------------- SOCKET SERVER ---------------- */

// 🔥 Create HTTP server
const httpServer = createServer(app);

// 🔥 Attach Socket.io
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

// 🔥 Make io available in controllers
app.set("io", io);

// 🔥 Handle socket connections
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Join conversation room
  socket.on("join_conversation", (conversationId) => {
    socket.join(`room_${conversationId}`);
    console.log(`Joined room_${conversationId}`);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

/* ---------------- START SERVER ---------------- */
const PORT = process.env.PORT || 4000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});