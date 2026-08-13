import { Router, RequestHandler } from "express";
import { verifyToken } from "../middleware/authMiddleware";
import { catalogUpload } from "../middleware/upload.middleware";
import {
  saveBusinessInfo,
  uploadCatalog,
  uploadCatalogFile,
  savePaymentKeys,
  saveChannels,
  completeOnboarding,
  getOnboardingStatus,
  getOnboardingData,
} from "../controllers/onboarding.controller";

const router = Router();

// All onboarding routes require auth
router.use(verifyToken as RequestHandler);

router.get("/status", getOnboardingStatus as RequestHandler);
router.get("/me", getOnboardingData as RequestHandler);
router.post("/business", saveBusinessInfo as RequestHandler);
router.post("/catalog", uploadCatalog as RequestHandler);
router.post("/catalog-file", catalogUpload.single("file"), uploadCatalogFile as RequestHandler);
router.post("/payments", savePaymentKeys as RequestHandler);
router.post("/channels", saveChannels as RequestHandler);
router.post("/complete", completeOnboarding as RequestHandler);

export default router;