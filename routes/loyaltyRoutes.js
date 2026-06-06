import express from "express";
import {
  getMyLoyalty,
  getMyLoyaltyHistory,
  getLoyaltySettings,
  updateLoyaltySettings,
} from "../controllers/loyaltyController.js";
import protect from "../middlewares/authWebToken.js";
import admin from "../middlewares/adminMiddleware.js";

const router = express.Router();

// User -- balance + history
router.get("/me", protect, getMyLoyalty);
router.get("/me/history", protect, getMyLoyaltyHistory);

// Admin -- earn/redeem configuration
router.get("/settings", protect, admin, getLoyaltySettings);
router.put("/settings", protect, admin, updateLoyaltySettings);

export default router;
