import { Router } from "express";

import rateLimit from "express-rate-limit";

import { submitContact } from "../controllers/contact.controller";

const router = Router();

/*
 * Public contact form.
 *
 * Keep this endpoint rate-limited because it is unauthenticated
 * and sends an email notification.
 */
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    success: false,
    message:
      "Too many contact requests. Please try again later.",
  },
});

router.post(
  "/",
  contactLimiter,
  submitContact
);

export default router;