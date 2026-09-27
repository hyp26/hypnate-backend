import { Router } from "express";

import rateLimit from "express-rate-limit";

import { submitDataDeletionRequest } from "../controllers/privacy.controller";

const router = Router();

/*
 * Public data-deletion request intake (Meta privacy compliance).
 *
 * Unauthenticated by design — a deletion request may arrive
 * without a Hypnate login session — so keep it rate-limited.
 */
const deletionRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

router.post(
  "/data-deletion",
  deletionRequestLimiter,
  submitDataDeletionRequest
);

export default router;
