import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    PORT: z.coerce.number().int().positive().default(4000),

    DATABASE_URL: z
      .string()
      .trim()
      .min(1, "DATABASE_URL is required")
      .url("DATABASE_URL must be a valid URL"),

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
      .min(16, "ENCRYPTION_KEY must be at least 16 characters"),

    FRONTEND_URL: z
      .string()
      .trim()
      .url("FRONTEND_URL must be a valid URL"),

    RESEND_API_KEY: z
      .string()
      .trim()
      .min(1, "RESEND_API_KEY is required"),

    CONTACT_NOTIFICATION_EMAIL: z
      .string()
      .trim()
      .email("CONTACT_NOTIFICATION_EMAIL must be a valid email"),

    CONTACT_FROM_EMAIL: z
      .string()
      .trim()
      .min(1, "CONTACT_FROM_EMAIL is required"),

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

    WHATSAPP_VERIFY_TOKEN: z
      .string()
      .trim()
      .min(16, "WHATSAPP_VERIFY_TOKEN must be at least 16 characters"),

    WEBHOOK_BASE_URL: z
      .string()
      .trim()
      .url("WEBHOOK_BASE_URL must be a valid URL"),

    INTERNAL_API_KEY: z
      .string()
      .trim()
      .min(32, "INTERNAL_API_KEY must be at least 32 characters"),

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

    META_GRAPH_VERSION: z
      .string()
      .trim()
      .default("v25.0"),

    PYTHON_WORKER_URL: z
      .string()
      .trim()
      .url()
      .optional(),

    GROQ_API_KEY: z
      .string()
      .trim()
      .optional(),

    GROQ_MODEL: z
      .string()
      .trim()
      .default("llama-3.3-70b-versatile"),

    REDIS_URL: z
      .string()
      .trim()
      .url()
      .optional(),

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

    RAZORPAY_KEY_ID: z
      .string()
      .trim()
      .optional(),

    RAZORPAY_KEY_SECRET: z
      .string()
      .trim()
      .optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      if (!env.INTERNAL_API_KEY) {
        ctx.addIssue({
          code: "custom",
          path: ["INTERNAL_API_KEY"],
          message: "INTERNAL_API_KEY is required in production",
        });
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map(
      (issue) =>
        `${issue.path.join(".") || "environment"}: ${issue.message}`
    )
    .join("\n");

  throw new Error(
    `Environment validation failed:\n${issues}`
  );
}

export const ENV = parsed.data;