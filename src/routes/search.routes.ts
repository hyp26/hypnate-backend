import { Router } from "express";
import { globalSearch } from "../controllers/search.controller";
import { verifyToken } from "../middleware/authMiddleware";

export const searchRouter = Router();

searchRouter.get("/", verifyToken, globalSearch);