import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import path from "path";
import jwt from "jsonwebtoken";


// HTTP + Socket.IO
import { createServer } from "http";
import { Server } from "socket.io";

// Routes
import dashboardRoutes from "./routes/dashboard.routes";
import productRoutes from "./routes/product.routes";
import uploadRoutes from "./routes/upload.routes";
import orderRoutes from "./routes/order.routes";
import authRoutes from "./routes/auth.routes";
import analyticsRoutes from "./routes/analytics.routes";
import customerRoutes from "./routes/customer.routes";
import notificationRoutes from "./routes/notification.routes";
import { searchRouter } from "./routes/search.routes";
import conversationRoutes from "./routes/conversation.routes";
import hypnatexRoutes from "./routes/hypnatex.routes";
import hypnatexInternalRoutes from "./routes/hypnatex.internal.routes";
import onboardingRoutes from "./routes/onboarding.routes";
import paymentRoutes from "./routes/payment.routes";
import contactRoutes from "./routes/contact.routes";
import channelRoutes from "./routes/channel.routes";
import healthRoutes from "./routes/health.routes";


// Webhooks
import telegramWebhookRoutes from "./routes/webhook/telegram";
import messageRoutes from "./routes/webhook/message.routes";
import whatsappWebhookRoutes from "./routes/webhook/whatsapp";

// Middleware
import { errorHandler } from "./middleware/errorHandler";

//utils
import { logger } from "./utils/logger";

// Prisma + JWT
import prisma from "./prisma/client";
import { JWT_SECRET } from "./utils/jwtConfig";

const app = express();

/* ---------------- TRUST PROXY ---------------- */
app.set("trust proxy", 1);

/* ---------------- CORS ---------------- */

const IS_PRODUCTION = process.env.NODE_ENV === "production";

const allowedOrigins = [
  "https://hypnate.in",
  "https://www.hypnate.in",
];

if (!IS_PRODUCTION) {
  allowedOrigins.push(
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173"
  );
}

const isAllowedOrigin = (origin?: string) => {
  // Requests without an Origin header include server-to-server,
  // health-check and some same-origin requests.
  if (!origin) {
    return true;
  }

  return allowedOrigins.includes(origin);
};

/* ---------------- SECURITY ---------------- */

app.use(helmet());
app.disable("x-powered-by");

/* ---------------- PARSERS ---------------- */

app.use(cookieParser());

app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      const url = req.url ?? "";

      if (
        url.startsWith(
          "/api/webhooks/whatsapp"
        )
      ) {
        (req as typeof req & { rawBody?: Buffer }).rawBody =
          Buffer.from(buf);
      }
    },
  })
);

/* ---------------- RATE LIMITING ---------------- */

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

app.use(
  "/api/auth/login",
  authLimiter
);

app.use(
  "/api/auth/register",
  authLimiter
);

app.use(
  "/api/auth/forgot-password",
  authLimiter
);

/* ---------------- ROUTES ---------------- */

app.use(
  "/api/products/upload",
  rateLimit({
    windowMs: 60 * 1000,
    max: 20,
  }),
  uploadRoutes
);

app.use(
  "/api/dashboard",
  dashboardRoutes
);

app.use(
  "/api/products",
  productRoutes
);

app.use(
  "/api/auth",
  authRoutes
);

app.use(
  "/api/orders",
  orderRoutes
);

app.use(
  "/api/analytics",
  analyticsRoutes
);

app.use(
  "/api/customers",
  customerRoutes
);

app.use(
  "/api/notifications",
  notificationRoutes
);

app.use(
  "/api/search",
  searchRouter
);

app.use(
  "/api/conversations",
  conversationRoutes
);

app.use(
  "/api/payments",
  paymentRoutes
);

app.use(
  "/api/contact",
  contactRoutes
);

app.use(
  "/api/channels",
  channelRoutes
);

// IMPORTANT: internal BEFORE public
app.use(
  "/api/hypnate-x/internal",
  hypnatexInternalRoutes
);

app.use(
  "/api/hypnate-x",
  hypnatexRoutes
);

app.use(
  "/api/onboarding",
  onboardingRoutes
);

/* ---------------- WEBHOOKS ---------------- */

app.use(
  "/api/webhooks/telegram",
  telegramWebhookRoutes
);

app.use(
  "/api/webhooks/whatsapp",
  whatsappWebhookRoutes
);

app.use(
  "/api/messages",
  messageRoutes
);

/* ---------------- STATIC ---------------- */

app.use(
  "/uploads",
  express.static(
    path.join(__dirname, "../uploads")
  )
);

/* ---------------- HEALTH ---------------- */

app.get(
  "/api/health",
  (_, res) => {
    res.json({
      status: "ok",
    });
  }
);

/* ---------------- ERROR HANDLER ---------------- */

app.use(errorHandler);

/* ---------------- SOCKET SERVER ---------------- */

const httpServer = createServer(app);

/*
 * Socket.IO must use the same trusted origins as HTTP.
 *
 * NEVER use:
 *
 *   origin: "*"
 *
 * for an authenticated multi-tenant application.
 */
const io = new Server(httpServer, {
  cors: {
    origin: function (origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(
          new Error("Not allowed by Socket.IO CORS")
        );
      }
    },

    credentials: true,
  },
});

/*
 * Make Socket.IO available to controllers.
 */
app.set("io", io);

/* ---------------- SOCKET AUTH HELPERS ---------------- */

/**
 * Parse a specific cookie from the raw Cookie header.
 *
 * We use the HttpOnly accessToken cookie that the existing
 * authentication system already sets.
 */
const getCookieValue = (
 cookieHeader: string | undefined,
  cookieName: string
): string | undefined => {
  if (!cookieHeader) {
    return undefined;
  }

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const name = cookie
      .slice(0, separatorIndex)
      .trim();

    if (name !== cookieName) {
      continue;
    }

    return decodeURIComponent(
      cookie.slice(separatorIndex + 1).trim()
    );
  }

  return undefined;
};

/* ---------------- SOCKET CONNECTION ---------------- */

io.use(async (socket, next) => {
  try {
    /*
     * Socket.IO handshake requests include the browser's
     * cookies, including the HttpOnly accessToken cookie.
     */
    const cookieHeader =
      socket.handshake.headers.cookie;

    const accessToken = getCookieValue(
      cookieHeader,
      "accessToken"
    );

    if (!accessToken) {
      return next(
        new Error("Unauthorized")
      );
    }

    let decoded: {
      id: number;
      role?: string;
      sellerId?: number | null;
    };

    try {
      decoded = jwt.verify(
        accessToken,
        JWT_SECRET
      ) as typeof decoded;
    } catch {
      return next(
        new Error("Unauthorized")
      );
    }

    if (!decoded.id) {
      return next(
        new Error("Unauthorized")
      );
    }

    /*
     * Do not trust sellerId from the JWT alone.
     * Resolve the current user from the database.
     */
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

    if (!user || !user.sellerId) {
      return next(
        new Error("Unauthorized")
      );
    }

    /*
     * Store the authenticated identity on the socket.
     */
    socket.data.userId = user.id;
    socket.data.sellerId = user.sellerId;

    return next();
  } catch (err) {
    logger.error(
      "Socket authentication error:",
      err
    );

    return next(
      new Error("Unauthorized")
    );
  }
});

io.on("connection", (socket) => {
  const sellerId = socket.data.sellerId;

  /*
   * Every authenticated socket joins its seller room.
   *
   * This is the room used for seller-scoped conversation
   * updates.
   */
  socket.join(`seller_${sellerId}`);

  /*
   * Join conversation room.
   *
   * CRITICAL:
   * Never trust the conversationId supplied by the browser.
   *
   * Verify that the requested conversation belongs to the
   * authenticated seller before allowing the socket into
   * the conversation room.
   */
  socket.on(
    "join_conversation",
    async (conversationId) => {
      try {
        const id = Number(conversationId);

        if (
          !Number.isInteger(id) ||
          id <= 0
        ) {
          return;
        }

        const conversation =
          await prisma.conversation.findFirst({
            where: {
              id,
              sellerId,
            },

            select: {
              id: true,
            },
          });

        if (!conversation) {
          /*
           * Do not reveal whether another tenant's
           * conversation exists.
           */
          socket.emit(
            "conversation_access_denied",
            {
              conversationId: id,
            }
          );

          return;
        }

        socket.join(`room_${conversation.id}`);
      } catch (err) {
        logger.error(
          "Socket conversation authorization error:",
          err
        );
      }
    }
  );

  /*
   * Leave conversation room.
   */
  socket.on(
    "leave_conversation",
    (conversationId) => {
      const id = Number(conversationId);

      if (
        !Number.isInteger(id) ||
        id <= 0
      ) {
        return;
      }

      socket.leave(`room_${id}`);
    }
  );

  socket.on("disconnect", () => {
    // Intentionally no sensitive logging.
  });
});

/* ---------------- START SERVER ---------------- */

const PORT = process.env.PORT || 4000;

logger.info("HTTP server started", {
  port: PORT,
  environment: process.env.NODE_ENV ?? "development",
});