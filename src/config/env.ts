import "dotenv/config";
import { z } from "zod";

const optionalUrl = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === ""
      ? undefined
      : value,
  z.string().trim().url().optional()
);

const optionalString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === ""
      ? undefined
      : value,
  z.string().trim().optional()
);

const envSchema = z.object({
  // ---------------------------------------------------------------------------
  // Application
  // ---------------------------------------------------------------------------

  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(4000),

  // ---------------------------------------------------------------------------
  // Database
  // ---------------------------------------------------------------------------

  DATABASE_URL: z
    .string()
    .trim()
    .min(1, "DATABASE_URL is required")
    .url("DATABASE_URL must be a valid URL"),

  // ---------------------------------------------------------------------------
  // Authentication / Security
  // ---------------------------------------------------------------------------

  JWT_SECRET: z
    .string()
    .trim()
    .min(32, "JWT_SECRET must be at least 32 characters"),

  REFRESH_SECRET: z
    .string()
    .trim()
    .min(32, "REFRESH_SECRET must be at least 32 characters"),

  ENCRYPTION_KEY: z
    .string()
    .trim()
    .min(32, "ENCRYPTION_KEY must be at least 32 characters"),

  INTERNAL_API_KEY: z
    .string()
    .trim()
    .min(32, "INTERNAL_API_KEY must be at least 32 characters"),

  // ---------------------------------------------------------------------------
  // Frontend / CORS
  // ---------------------------------------------------------------------------

  FRONTEND_URL: z
    .string()
    .trim()
    .url("FRONTEND_URL must be a valid URL"),

  // ---------------------------------------------------------------------------
  // Email / Contact
  // ---------------------------------------------------------------------------

  RESEND_API_KEY: z
    .string()
    .trim()
    .min(1, "RESEND_API_KEY is required"),

  CONTACT_NOTIFICATION_EMAIL: z
    .string()
    .trim()
    .email(
      "CONTACT_NOTIFICATION_EMAIL must be a valid email"
    ),

  CONTACT_FROM_EMAIL: z
    .string()
    .trim()
    .min(1, "CONTACT_FROM_EMAIL is required"),

  // ---------------------------------------------------------------------------
  // Meta / WhatsApp
  // ---------------------------------------------------------------------------

  META_APP_ID: z
    .string()
    .trim()
    .min(1, "META_APP_ID is required"),

  META_APP_SECRET: z
    .string()
    .trim()
    .min(1, "META_APP_SECRET is required"),

  META_REDIRECT_URI: z
    .string()
    .trim()
    .url("META_REDIRECT_URI must be a valid URL"),

  META_GRAPH_VERSION: z
    .string()
    .trim()
    .default("v25.0"),

  WHATSAPP_VERIFY_TOKEN: z
    .string()
    .trim()
    .min(
      16,
      "WHATSAPP_VERIFY_TOKEN must be at least 16 characters"
    ),

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------

  WEBHOOK_BASE_URL: z
    .string()
    .trim()
    .url("WEBHOOK_BASE_URL must be a valid URL"),

  // ---------------------------------------------------------------------------
  // Telegram
  // ---------------------------------------------------------------------------
  // No global Telegram bot token is required here.
  // Telegram credentials are stored per ChannelConnection.

  // ---------------------------------------------------------------------------
  // AI / Workers
  // ---------------------------------------------------------------------------

  PYTHON_WORKER_URL: optionalUrl,

  GROQ_API_KEY: optionalString,

  GROQ_MODEL: z
    .string()
    .trim()
    .default("llama-3.3-70b-versatile"),

  // ---------------------------------------------------------------------------
  // Redis
  // ---------------------------------------------------------------------------

  REDIS_URL: optionalUrl,

  // ---------------------------------------------------------------------------
  // Cloudinary
  // ---------------------------------------------------------------------------

  CLOUDINARY_CLOUD_NAME: z
    .string()
    .trim()
    .min(1, "CLOUDINARY_CLOUD_NAME is required"),

  CLOUDINARY_API_KEY: z
    .string()
    .trim()
    .min(1, "CLOUDINARY_API_KEY is required"),

  CLOUDINARY_API_SECRET: z
    .string()
    .trim()
    .min(1, "CLOUDINARY_API_SECRET is required"),

  // ---------------------------------------------------------------------------
  // Authentication configuration
  // ---------------------------------------------------------------------------

  TOKEN_EXPIRY: z
    .string()
    .trim()
    .default("7d"),

  SALT_ROUNDS: z.coerce
    .number()
    .int()
    .min(10)
    .max(15)
    .default(10),

  // ---------------------------------------------------------------------------
  // Uploads
  // ---------------------------------------------------------------------------

  UPLOADS_DIR: z
    .string()
    .trim()
    .default("./uploads"),

  MAX_FILE_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),

  MAX_CATALOG_FILE_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 1024 * 1024),

  // ---------------------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------------------

  RAZORPAY_KEY_ID: optionalString,

  RAZORPAY_KEY_SECRET: optionalString,

  RAZORPAY_WEBHOOK_SECRET: optionalString,

  RAZORPAY_PLAN_STARTER_MONTHLY: optionalString,
  RAZORPAY_PLAN_PRO_MONTHLY: optionalString,
  RAZORPAY_PLAN_BUSINESS_MONTHLY: optionalString,
  RAZORPAY_PLAN_STARTER_YEARLY: optionalString,
  RAZORPAY_PLAN_PRO_YEARLY: optionalString,
  RAZORPAY_PLAN_BUSINESS_YEARLY: optionalString,
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => {
      const path =
        issue.path.length > 0
          ? issue.path.join(".")
          : "environment";

      return `${path}: ${issue.message}`;
    })
    .join("\n");

  throw new Error(
    `Environment validation failed:\n${issues}`
  );
}

export const ENV = parsed.data;