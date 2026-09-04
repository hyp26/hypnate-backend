import { z } from "zod";

export const contactSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Name must be at least 2 characters")
      .max(100, "Name is too long"),

    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("Invalid email address")
      .max(254, "Email address is too long"),

    phone: z
      .string()
      .trim()
      .max(30, "Phone number is too long")
      .optional()
      .or(z.literal("")),

    company: z
      .string()
      .trim()
      .max(150, "Company name is too long")
      .optional()
      .or(z.literal("")),

    subject: z
      .string()
      .trim()
      .max(200, "Subject is too long")
      .optional()
      .or(z.literal("")),

    message: z
      .string()
      .trim()
      .min(10, "Message must be at least 10 characters")
      .max(5000, "Message is too long"),
  })
  .strict();

export type ContactInput = z.infer<typeof contactSchema>;