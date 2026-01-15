import express from "express";
import {
  createOrder,
  getMyOrders,
  getAllOrders,
  updateOrderStatus,
} from "../controllers/orderController.js";
import protect from "../middlewares/authWebToken.js";
import admin from "../middlewares/adminMiddleware.js";



const router = express.Router();

router.post("/", protect, createOrder);
router.get("/my", protect, getMyOrders);

// Admin
router.get("/", protect, admin, getAllOrders);
router.put("/:id", protect, admin, updateOrderStatus);

export default router;
