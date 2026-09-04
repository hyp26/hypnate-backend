import { Request, Response, NextFunction } from "express";
import { Resend } from "resend";

import prisma from "../prisma/client";
import { contactSchema } from "../schemas/contact.schema";
import { logger } from "../utils/logger";

const resend = new Resend(process.env.RESEND_API_KEY);

const CONTACT_NOTIFICATION_EMAIL =
  process.env.CONTACT_NOTIFICATION_EMAIL;

const CONTACT_FROM_EMAIL =
  process.env.CONTACT_FROM_EMAIL ||
  "Hypnate <noreply@hypnate.in>";

export const submitContact = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    /*
     * Validate the complete request body with Zod.
     */
    const parsed = contactSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: "Invalid contact form submission",
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const {
      name,
      email,
      phone,
      company,
      subject,
      message,
    } = parsed.data;

    /*
     * Persist the submission before sending the notification.
     *
     * This ensures that a temporary email-provider failure
     * does not cause the actual contact request to disappear.
     */
    const submission = await prisma.contactSubmission.create({
      data: {
        name,
        email,
        phone: phone || null,
        company: company || null,
        subject: subject || null,
        message,
      },
      select: {
        id: true,
        createdAt: true,
      },
    });

    /*
     * Notification email.
     *
     * CONTACT_NOTIFICATION_EMAIL must be configured in production.
     */
    if (!CONTACT_NOTIFICATION_EMAIL) {
      logger.error(
        "Contact notification email is not configured",
        undefined,
        {
          submissionId: submission.id,
        }
      );

      /*
       * The submission is safely persisted, so don't discard it.
       */
      res.status(201).json({
        success: true,
        message:
          "Your message has been received. We will get back to you soon.",
      });

      return;
    }

    try {
      await resend.emails.send({
        from: CONTACT_FROM_EMAIL,
        to: CONTACT_NOTIFICATION_EMAIL,
        replyTo: email,
        subject:
          subject?.trim()
            ? `Website contact: ${subject.trim()}`
            : `New website contact from ${name}`,

        html: `
          <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#111">
            <h2 style="margin:0 0 24px">New Hypnate Contact Submission</h2>

            <table style="width:100%;border-collapse:collapse">
              <tr>
                <td style="padding:8px 0;font-weight:600;width:140px">Name</td>
                <td style="padding:8px 0">${escapeHtml(name)}</td>
              </tr>

              <tr>
                <td style="padding:8px 0;font-weight:600">Email</td>
                <td style="padding:8px 0">
                  <a href="mailto:${escapeHtml(email)}">
                    ${escapeHtml(email)}
                  </a>
                </td>
              </tr>

              ${
                phone
                  ? `
                    <tr>
                      <td style="padding:8px 0;font-weight:600">Phone</td>
                      <td style="padding:8px 0">${escapeHtml(phone)}</td>
                    </tr>
                  `
                  : ""
              }

              ${
                company
                  ? `
                    <tr>
                      <td style="padding:8px 0;font-weight:600">Company</td>
                      <td style="padding:8px 0">${escapeHtml(company)}</td>
                    </tr>
                  `
                  : ""
              }

              ${
                subject
                  ? `
                    <tr>
                      <td style="padding:8px 0;font-weight:600">Subject</td>
                      <td style="padding:8px 0">${escapeHtml(subject)}</td>
                    </tr>
                  `
                  : ""
              }
            </table>

            <div style="margin-top:28px">
              <h3 style="margin-bottom:10px">Message</h3>

              <div style="
                background:#f6f6f6;
                border-radius:8px;
                padding:16px;
                white-space:pre-wrap;
              ">
                ${escapeHtml(message)}
              </div>
            </div>

            <p style="margin-top:28px;color:#777;font-size:13px">
              Submission ID: ${submission.id}
            </p>
          </div>
        `,
      });

      logger.info("Contact notification sent", {
        submissionId: submission.id,
      });
    } catch (emailError) {
      /*
       * The contact request is already persisted.
       * Do not expose provider details to the visitor.
       */
      logger.error(
        "Failed to send contact notification",
        emailError,
        {
          submissionId: submission.id,
        }
      );
    }

    /*
     * Always return a generic success response.
     * Don't expose internal notification failures.
     */
    res.status(201).json({
      success: true,
      message:
        "Your message has been received. We will get back to you soon.",
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Basic HTML escaping for user-controlled content
 * inserted into the notification email.
 */
const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};