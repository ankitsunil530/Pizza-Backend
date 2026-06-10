
import crypto from "crypto";
import razorpay, { assertRazorpayReady, getRazorpayMode } from "../config/razorpay.js";
import Cart from "../models/Cart.js";
import Order from "../models/Order.js";
import { awardLoyaltyForDeliveredOrder } from "./loyaltyController.js";

export const createRazorpayOrder = async (req, res) => {
  try {
    assertRazorpayReady();

    const { orderId } = req.body;
    const order = await Order.findOne({ _id: orderId, user: req.user._id });

    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.paymentStatus === "paid") return res.status(400).json({ error: "Order already paid" });

    const options = {
      amount: Math.round(order.totalAmount * 100),
      currency: "INR",
      receipt: order._id.toString(),
    };

    const razorpayOrder = await razorpay.orders.create(options);

    // Bind this Razorpay order to the local order so verifyPayment can
    // confirm a later payment actually belongs to this order. Re-initiating
    // payment rebinds to the latest Razorpay order.
    order.razorpayOrderId = razorpayOrder.id;
    await order.save();

    res.json({
      success: true,
      order: razorpayOrder,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Create Razorpay order error:", error);
    res.status(500).json({ error: error.message || "Failed to create payment order" });
  }
};

export const verifyPayment = async (req, res) => {
  try {
    assertRazorpayReady();

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    const order = await Order.findOne({ _id: orderId, user: req.user._id });
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Idempotency: a retried verify for an already-paid order is a no-op success
    // (prevents double cart-clear / re-processing on a duplicate handler call).
    if (order.paymentStatus === "paid") {
      return res.json({ success: true, data: order });
    }

    // Bind the payment to THIS order. A valid signature only proves the
    // (order_id, payment_id) pair is an authentic Razorpay payment -- it does
    // NOT prove the payment was made for this order or for the right amount.
    // Without this check, a genuine cheap payment (e.g. a real Re.1 order the
    // attacker paid) could be replayed against an expensive order to mark it
    // paid. The amount is implicitly enforced too: the bound Razorpay order was
    // created server-side with this order's exact total.
    if (!order.razorpayOrderId || order.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({ error: "Payment does not match this order" });
    }

    // Replay guard: a given Razorpay payment may settle exactly one order.
    const alreadyUsed = await Order.findOne({
      razorpayPaymentId: razorpay_payment_id,
      _id: { $ne: order._id },
    });
    if (alreadyUsed) {
      return res.status(400).json({ error: "Payment already used for another order" });
    }

    order.paymentStatus = "paid";
    order.razorpayPaymentId = razorpay_payment_id;
    await order.save();

    // Award loyalty points immediately for paid online orders
    try {
      await awardLoyaltyForDeliveredOrder(order);
    } catch (loyaltyErr) {
      console.error("Failed to award loyalty points after online payment verification:", loyaltyErr);
    }

    const cart = await Cart.findOne({ user: req.user._id });
    if (cart) {
      cart.items = [];
      await cart.save();
    }

    res.json({ success: true, data: order });
  } catch (error) {
    console.error("Verify payment error:", error);
    res.status(500).json({ error: "Failed to verify payment" });
  }
};

export const getPaymentConfig = async (req, res) => {
  res.json({ success: true, data: getRazorpayMode() });
};

export const createPaymentForOrder = createRazorpayOrder;
