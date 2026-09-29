import { z } from "zod";

/* ----------------------------------------------------
   SHARED
---------------------------------------------------- */

export const optionalDate = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().datetime({ offset: true }).optional()
);

/* ----------------------------------------------------
   AUTH
---------------------------------------------------- */

export const adminLoginSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("Invalid email address")
      .max(254),
    password: z.string().min(1, "Password is required").max(200),
  })
  .strict();

export const adminChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(200)
      .regex(
        /^(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*]).{8,}$/,
        "Password must contain an uppercase letter, a number and a special character"
      ),
  })
  .strict();

/* ----------------------------------------------------
   ADMIN USERS
---------------------------------------------------- */

export const createAdminAccountSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("Invalid email address")
      .max(254),
    firstName: z.string().trim().min(1, "First name is required").max(100),
    lastName: z.string().trim().min(1, "Last name is required").max(100),
    role: z.enum(["ADMIN", "SUPPORT"]),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(200)
      .regex(
        /^(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*]).{8,}$/,
        "Password must contain an uppercase letter, a number and a special character"
      ),
  })
  .strict();

export const updateAdminRoleSchema = z
  .object({
    role: z.enum(["ADMIN", "SUPPORT"]),
  })
  .strict();

export const updateAdminStatusSchema = z
  .object({
    status: z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]),
  })
  .strict();

/* ----------------------------------------------------
   SELLERS / CUSTOMERS / ORDERS
---------------------------------------------------- */

export const listSellersSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().max(200).optional(),
      status: z
        .enum(["ACTIVE", "INACTIVE", "SUSPENDED", "TRIALING"])
        .optional(),
      plan: z.string().trim().max(50).optional(),
      sort: z.enum(["createdAt_desc", "createdAt_asc", "revenue_desc"]).default("createdAt_desc"),
    })
});

export const updateSellerStatusSchema = z
  .object({
    status: z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]),
  })
  .strict();

export const listCustomersSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().max(200).optional(),
      sellerId: z.coerce.number().int().positive().optional(),
    })
});

export const listOrdersSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().max(200).optional(),
      status: z
        .enum(["PENDING", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED"])
        .optional(),
      paymentStatus: z
        .enum(["UNPAID", "PAID", "FAILED", "REFUNDED"])
        .optional(),
      sellerId: z.coerce.number().int().positive().optional(),
    })
});

export const updateOrderStatusSchema = z
  .object({
    status: z.enum([
      "PENDING",
      "PROCESSING",
      "SHIPPED",
      "DELIVERED",
      "CANCELLED",
      "REFUNDED",
    ]),
  })
  .strict();

/* ----------------------------------------------------
   SUBSCRIPTIONS
---------------------------------------------------- */

export const listSubscriptionsSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      plan: z.string().trim().max(50).optional(),
      status: z
        .enum(["ACTIVE", "CANCELLED", "EXPIRED", "PAST_DUE", "TRIALING"])
        .optional(),
    })
});

export const updateSubscriptionSchema = z
  .object({
    plan: z.enum(["FREE", "BASIC", "STARTER", "PRO", "BUSINESS", "ENTERPRISE"]).optional(),
    status: z
      .enum(["ACTIVE", "CANCELLED", "EXPIRED", "PAST_DUE"])
      .optional(),
  })
  .strict()
  .refine((data) => data.plan !== undefined || data.status !== undefined, {
    message: "At least one of plan or status is required",
  });

/* ----------------------------------------------------
   TICKETS
---------------------------------------------------- */

export const createTicketSchema = z
  .object({
    subject: z.string().trim().min(3).max(300),
    description: z.string().trim().max(10000).optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
    category: z.string().trim().max(100).optional(),
    sellerId: z.coerce.number().int().positive().optional(),
    customerId: z.coerce.number().int().positive().optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  })
  .strict();

export const updateTicketSchema = z
  .object({
    subject: z.string().trim().min(3).max(300).optional(),
    description: z.string().trim().max(10000).optional(),
    status: z
      .enum(["OPEN", "PENDING", "IN_PROGRESS", "RESOLVED", "CLOSED"])
      .optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    category: z.string().trim().max(100).optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    assignedToAdminId: z.coerce.number().int().positive().nullable().optional(),
  })
  .strict();

export const createTicketMessageSchema = z
  .object({
    body: z.string().trim().min(1, "Message body is required").max(10000),
    isInternal: z.boolean().default(false),
  })
  .strict();

export const listTicketsSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().max(200).optional(),
      status: z
        .enum(["OPEN", "PENDING", "IN_PROGRESS", "RESOLVED", "CLOSED"])
        .optional(),
      priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
      assignedToAdminId: z.coerce.number().int().positive().optional(),
    })
});

/* ----------------------------------------------------
   ANNOUNCEMENTS / FAQ / CONTENT
---------------------------------------------------- */

export const announcementSchema = z
  .object({
    title: z.string().trim().min(3).max(300),
    content: z.string().trim().min(1).max(50000),
    type: z.enum(["GENERAL", "MAINTENANCE", "FEATURE", "SECURITY"]).default("GENERAL"),
    status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).default("DRAFT"),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
    targetAudience: z.enum(["ALL", "SELLERS", "CUSTOMERS"]).default("ALL"),
    startsAt: optionalDate,
    endsAt: optionalDate,
  })
  .strict();

export const faqSchema = z
  .object({
    question: z.string().trim().min(5).max(500),
    answer: z.string().trim().min(1).max(20000),
    category: z.string().trim().min(1).max(100).default("General"),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
    order: z.coerce.number().int().min(0).default(0),
    isPublished: z.boolean().default(false),
  })
  .strict();

export const contentPageSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(200)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Slug must be lowercase letters, numbers and hyphens"
      ),
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(100000),
    status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).default("DRAFT"),
  })
  .strict();

/* ----------------------------------------------------
   SETTINGS / FEATURE FLAGS
---------------------------------------------------- */

export const adminSettingsSchema = z
  .object({
    siteName: z.string().trim().min(1).max(200).optional(),
    siteDescription: z.string().trim().max(500).optional(),
    logoUrl: z.string().trim().max(500).optional(),
    faviconUrl: z.string().trim().max(500).optional(),
    defaultCurrency: z.string().trim().min(1).max(10).optional(),
    defaultTimezone: z.string().trim().min(1).max(100).optional(),
    supportEmail: z
      .string()
      .trim()
      .toLowerCase()
      .email("Invalid support email")
      .max(254)
      .optional(),
  })
  .strict();

export const featureFlagsSchema = z
  .object({
    maintenanceMode: z.boolean().optional(),
    newUserRegistration: z.boolean().optional(),
    emailNotifications: z.boolean().optional(),
    analyticsDashboard: z.boolean().optional(),
    subscriptionUpgrades: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => Object.keys(data).length > 0,
    { message: "At least one feature flag is required" }
  );

/* ----------------------------------------------------
   AUDIT LOGS
---------------------------------------------------- */

export const listAuditLogsSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      action: z
        .enum(["CREATE", "UPDATE", "DELETE", "LOGIN", "LOGOUT", "SETTINGS"])
        .optional(),
      adminUserId: z.coerce.number().int().positive().optional(),
      entityType: z.string().trim().max(100).optional(),
      search: z.string().trim().max(200).optional(),
    })
});
