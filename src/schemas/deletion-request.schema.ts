import { z } from "zod";

/*
 * Public data-deletion request payload (Meta privacy compliance).
 *
 * Deliberately minimal and strict: only a contact email and an
 * optional free-text note are accepted. Account/user/seller IDs
 * are rejected so an anonymous caller can never target an account.
 */
export const dataDeletionRequestSchema = z
  .object({
    contactEmail: z
      .string()
      .trim()
      .toLowerCase()
      .email("Invalid email address")
      .max(254, "Email address is too long"),

    details: z
      .string()
      .trim()
      .max(2000, "Details are too long")
      .optional()
      .or(z.literal("")),
  })
  .strict();

export type DataDeletionRequestInput = z.infer<
  typeof dataDeletionRequestSchema
>;
