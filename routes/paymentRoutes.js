import express from "express";
import { createPaymentForOrder, createRazorpayOrder, verifyPayment } from "../controllers/paymentController.js";
import protect from "../middlewares/authWebToken.js";


const router = express.Router();

router.post("/create-order", protect, createRazorpayOrder);
router.post("/verify", protect, verifyPayment);
router.post("/pay-existing-order", protect, createPaymentForOrder);
export default router;
