import razorpay from "../config/razorpay.js";
import crypto from "crypto";
import Order from "../models/Order.js";

export const createRazorpayOrder = async (req, res) => {
  const { orderId } = req.body;

  const order = await Order.findById(orderId);

  if (!order) return res.status(404).json({ error: "Order not found" });

  const options = {
    amount: order.totalAmount * 100,
    currency: "INR",
    receipt: order._id.toString(),
  };

  const razorpayOrder = await razorpay.orders.create(options);

  res.json({
    success: true,
    order: razorpayOrder,
    key: process.env.RAZORPAY_KEY_ID,
  });
};

export const verifyPayment = async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    orderId,
  } = req.body;

  const body = razorpay_order_id + "|" + razorpay_payment_id;

  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: "Invalid payment signature" });
  }

  const order = await Order.findById(orderId);
  order.paymentStatus = "paid";
  await order.save();

  res.json({ success: true });
};
export const createPaymentForOrder = async (req, res) => {
  const { orderId } = req.body;

  const order = await Order.findById(orderId);

  if (!order) return res.status(404).json({ error: "Order not found" });

  if (order.paymentStatus === "paid") {
    return res.status(400).json({ error: "Order already paid" });
  }

  const razorpayOrder = await razorpay.orders.create({
    amount: order.totalAmount * 100,
    currency: "INR",
    receipt: `order_${order._id}`,
  });

  res.json({
    key: process.env.RAZORPAY_KEY_ID,
    order: razorpayOrder,
  });
};