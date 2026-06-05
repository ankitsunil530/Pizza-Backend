import express from "express";
import {
  validateCoupon,
  getAllCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  getAvailableCoupons,
} from "../controllers/couponController.js";
import protect from "../middlewares/authWebToken.js";
import admin from "../middlewares/adminMiddleware.js";

const router = express.Router();

// User -- preview a coupon's discount (protected)
router.post("/validate", protect, validateCoupon);
router.get("/available", protect, getAvailableCoupons);

// Admin -- manage coupons
router.get("/", protect, admin, getAllCoupons);
router.post("/", protect, admin, createCoupon);
router.put("/:id", protect, admin, updateCoupon);
router.delete("/:id", protect, admin, deleteCoupon);

export default router;
