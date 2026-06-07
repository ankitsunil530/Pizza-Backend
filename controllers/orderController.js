import Order from "../models/Order.js";
import Cart from "../models/Cart.js";
import Coupon from "../models/Coupon.js";
import User from "../models/User.js";
import LoyaltyTransaction from "../models/LoyaltyTransaction.js";
import { evaluateCoupon } from "./couponController.js";
import {
  evaluateRedemption,
  getLoyaltySettingsDoc,
  awardLoyaltyForDeliveredOrder,
  reverseLoyaltyForOrder,
} from "./loyaltyController.js";

/**
 * Release the coupon usage slot an order claimed, mirroring the rollback in
 * createOrder's catch block. The usedCount: { $gt: 0 } guard floors the counter
 * at zero so a release can never drive it negative. Best-effort: a release
 * failure is logged and swallowed so it can never fail the cancellation itself.
 */
const releaseCouponForOrder = async (order) => {
  if (!order || !order.couponCode) return;
  try {
    await Coupon.updateOne(
      { code: order.couponCode, usedCount: { $gt: 0 } },
      { $inc: { usedCount: -1 } }
    );
  } catch (err) {
    console.error("Failed to release coupon slot on cancellation:", err);
  }
};

/**
 * Cancel an order exactly once and reverse everything it claimed (the coupon
 * usage slot and any loyalty points). The atomic findOneAndUpdate transition
 * (status != "cancelled" -> "cancelled") guarantees only the first caller
 * observes the transition, so concurrent or repeated cancels can never
 * double-release a coupon slot or double-refund points. claimFilter scopes WHO
 * may cancel and FROM WHICH statuses (admin: any order by id; user: only their
 * own order while still cancellable).
 *
 * Returns the cancelled order, or null if nothing matched the claim (not found,
 * not owned, no longer cancellable, or already cancelled).
 */
const performCancellation = async (claimFilter) => {
  // new: false returns the pre-update document, whose couponCode / pointsRedeemed
  // / pointsEarned are exactly what the reversals below operate on.
  const preDoc = await Order.findOneAndUpdate(
    { $and: [claimFilter, { orderStatus: { $ne: "cancelled" } }] },
    { $set: { orderStatus: "cancelled" } },
    { new: false }
  );
  if (!preDoc) return null;

  // The cancellation has already committed; the reversals are best-effort and
  // must not surface as a failed cancel. releaseCouponForOrder swallows its own
  // errors and reverseLoyaltyForOrder is idempotent (ledger-guarded).
  try {
    await releaseCouponForOrder(preDoc);
    await reverseLoyaltyForOrder(preDoc);
  } catch (sideErr) {
    console.error("Reversal after cancellation failed:", sideErr);
  }

  const order = await Order.findById(preDoc._id);
  return order || preDoc;
};

export const createOrder = async (req, res) => {
  try {
    const { address, phone, paymentMethod = "cod", deliveryFee = 0, couponCode, redeemPoints = 0 } = req.body;

    if (!address || address.trim().length < 12) {
      return res.status(400).json({ error: "Complete delivery address is required" });
    }

    if (!/^\d{10}$/.test(String(phone || ""))) {
      return res.status(400).json({ error: "Valid 10-digit phone number is required" });
    }

    if (!["cod", "online"].includes(paymentMethod)) {
      return res.status(400).json({ error: "Invalid payment method" });
    }

    const cart = await Cart.findOne({ user: req.user._id });

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);
    const safeDeliveryFee = Math.max(0, Number(deliveryFee) || 0);

    // Points and coupons are mutually exclusive (Phase 1): a user applies one or
    // the other, never both. Reject early if both are supplied.
    const wantsToRedeem = Math.floor(Number(redeemPoints) || 0) > 0;
    if (couponCode && String(couponCode).trim() && wantsToRedeem) {
      return res.status(400).json({
        error: "A coupon and loyalty points cannot be used on the same order",
      });
    }

    // Re-validate and recompute any coupon discount on the server. The client
    // cannot be trusted to send a discount amount, so we look the coupon up
    // fresh and run the same engine used by the validate endpoint.
    let discount = 0;
    let appliedCoupon = null;
    if (couponCode && String(couponCode).trim()) {
      const coupon = await Coupon.findOne({
        code: String(couponCode).trim().toUpperCase(),
      });
      if (!coupon) {
        return res.status(400).json({ error: "Coupon not found" });
      }

      // Count how many times this user has already redeemed this coupon across
      // non-cancelled orders (feeds the per-user limit check in evaluateCoupon).
      const userUsageCount = await Order.countDocuments({
        user: req.user._id,
        couponCode: coupon.code,
        orderStatus: { $ne: "cancelled" }
      });

      // Run the shared engine: validates active/expiry/min-order/per-user limit
      // and computes the authoritative discount. The global usageLimit read here
      // is an early-exit optimisation only -- the authoritative cap enforcement
      // is the atomic claim below.
      const result = evaluateCoupon(coupon, subtotal, userUsageCount);
      if (!result.ok) {
        return res.status(400).json({ error: result.reason });
      }

      // Atomically claim one global redemption slot. MongoDB applies a single-
      // document findOneAndUpdate atomically, so two concurrent orders can never
      // both take the last remaining slot -- closing the TOCTOU race that the
      // previous read-then-save() increment allowed (same class as #22).
      // usageLimit === 0 means unlimited; those coupons always pass the filter.
      const claimed = await Coupon.findOneAndUpdate(
        {
          _id: coupon._id,
          $or: [
            { usageLimit: 0 },
            { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
          ],
        },
        { $inc: { usedCount: 1 } },
        { new: true }
      );

      if (!claimed) {
        return res
          .status(400)
          .json({ error: "This coupon has reached its usage limit" });
      }

      discount = result.discount;
      appliedCoupon = claimed;
    }

    // Loyalty redemption (only when no coupon is applied -- see the mutual-
    // exclusion check above). Recompute server-side and atomically debit the
    // points before the order is created, exactly like the coupon slot claim.
    let redeemDiscount = 0;
    let pointsRedeemed = 0;
    if (!appliedCoupon && wantsToRedeem) {
      const setting = await getLoyaltySettingsDoc();
      const result = evaluateRedemption(
        setting,
        req.user.loyaltyPoints || 0,
        redeemPoints,
        subtotal
      );
      if (!result.ok) {
        return res.status(400).json({ error: result.reason });
      }

      if (result.pointsUsed > 0) {
        // Atomic conditional debit: the balance guard means two concurrent orders
        // can never spend the same points -- the second finds an insufficient
        // balance and is rejected. Same atomicity principle as the coupon claim.
        const claimedUser = await User.findOneAndUpdate(
          { _id: req.user._id, loyaltyPoints: { $gte: result.pointsUsed } },
          { $inc: { loyaltyPoints: -result.pointsUsed } },
          { new: true }
        );
        if (!claimedUser) {
          return res.status(400).json({ error: "Insufficient points" });
        }
        redeemDiscount = result.redeemDiscount;
        pointsRedeemed = result.pointsUsed;
      }
    }

    const totalAmount = subtotal - discount - redeemDiscount + safeDeliveryFee;

    let order;
    try {
      order = await Order.create({
        user: req.user._id,
        items: cart.items.map((item) => item.toObject()),
        subtotal,
        deliveryFee: safeDeliveryFee,
        discount,
        couponCode: appliedCoupon ? appliedCoupon.code : null,
        pointsRedeemed,
        totalAmount,
        address: address.trim(),
        phone: String(phone),
        paymentMethod,
        paymentStatus: paymentMethod === "cod" ? "cod" : "pending",
        orderStatus: "placed",
      });
    } catch (orderErr) {
      // The order failed to persist after we claimed a redemption slot, so
      // release that slot to keep usedCount honest -- a failed order must not
      // burn a coupon use. Best-effort: a rollback failure must never mask the
      // original order error.
      if (appliedCoupon) {
        try {
          await Coupon.updateOne(
            { _id: appliedCoupon._id, usedCount: { $gt: 0 } },
            { $inc: { usedCount: -1 } }
          );
        } catch (rollbackErr) {
          console.error(
            "Failed to release coupon slot after order creation error:",
            rollbackErr
          );
        }
      }
      if (pointsRedeemed > 0) {
        try {
          await User.updateOne(
            { _id: req.user._id },
            { $inc: { loyaltyPoints: pointsRedeemed } }
          );
        } catch (rollbackErr) {
          console.error(
            "Failed to refund loyalty points after order creation error:",
            rollbackErr
          );
        }
      }
      throw orderErr;
    }

    // Record the redemption in the ledger now that the order exists. The points
    // are already debited and the order is persisted, so a ledger write failure
    // must not fail the order -- log it for reconciliation instead.
    if (pointsRedeemed > 0) {
      try {
        const balUser = await User.findById(req.user._id).select("loyaltyPoints");
        await LoyaltyTransaction.create({
          user: req.user._id,
          type: "redeem",
          points: pointsRedeemed,
          order: order._id,
          balanceAfter: balUser ? balUser.loyaltyPoints : 0,
          description: `Redeemed ${pointsRedeemed} points on order ${order._id}`,
        });
      } catch (ledgerErr) {
        console.error("Failed to write loyalty redeem ledger row:", ledgerErr);
      }
    }

    if (paymentMethod === "cod") {
      cart.items = [];
      await cart.save();
    }

    res.status(201).json({
      success: true,
      data: order,
    });
  } catch (error) {
    console.error("Create order error:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
};

export const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id }).sort("-createdAt");
    res.json({ success: true, data: orders });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
};

export const getOrderById = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== "admin") query.user = req.user._id;

    const order = await Order.findOne(query).populate("user", "name email");
    if (!order) return res.status(404).json({ error: "Order not found" });

    res.json({ success: true, data: order });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch order" });
  }
};

export const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find().populate("user", "name email").sort("-createdAt");
    res.json({ success: true, data: orders });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
};

export const updateOrderStatus = async (req, res) => {
  try {
    const allowedStatuses = ["placed", "confirmed", "preparing", "out_for_delivery", "delivered", "cancelled"];
    if (!allowedStatuses.includes(req.body.status)) {
      return res.status(400).json({ error: "Invalid order status" });
    }

    // Cancellation is a full reversal (coupon slot + loyalty) that must run
    // exactly once, so route it through the shared atomic helper instead of a
    // plain status write. This also closes the slot leak where a cancelled
    // coupon order never released its global usedCount.
    if (req.body.status === "cancelled") {
      const cancelled = await performCancellation({ _id: req.params.id });
      if (cancelled) {
        return res.json({ success: true, data: cancelled });
      }
      // Nothing claimed: disambiguate not-found vs already-cancelled.
      const existing = await Order.findById(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Order not found" });
      }
      return res.json({ success: true, data: existing }); // already cancelled
    }

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const previousStatus = order.orderStatus;
    order.orderStatus = req.body.status;
    await order.save();

    // Loyalty earn on a genuine delivered transition. awardLoyaltyForDeliveredOrder
    // is idempotent, so a repeated set-to-same-status or a retry cannot
    // double-apply. A side-effect failure must not fail the status change itself.
    try {
      if (req.body.status === "delivered" && previousStatus !== "delivered") {
        await awardLoyaltyForDeliveredOrder(order);
      }
    } catch (loyaltyErr) {
      console.error("Loyalty update after order status change failed:", loyaltyErr);
    }

    res.json({ success: true, data: order });
  } catch (error) {
    res.status(500).json({ error: "Failed to update order status" });
  }
};

/**
 * User-facing self-service cancellation. A customer may cancel their OWN order
 * only while it is still "placed" or "confirmed" (before it leaves the
 * kitchen). Runs the same atomic, exactly-once reversal as the admin path
 * (coupon slot release + loyalty reversal).
 */
export const cancelMyOrder = async (req, res) => {
  try {
    // Scope strictly to the caller's own order so a user can never cancel
    // someone else's (closes the IDOR an admin-only route would leave open).
    const existing = await Order.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!existing) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Already cancelled -> idempotent success, no double reversal.
    if (existing.orderStatus === "cancelled") {
      return res.json({ success: true, data: existing });
    }

    const cancellable = ["placed", "confirmed"];
    if (!cancellable.includes(existing.orderStatus)) {
      return res
        .status(400)
        .json({ error: "This order can no longer be cancelled" });
    }

    // Atomic claim scoped to the user AND the cancellable statuses, so a status
    // change racing this request cannot let an order that just shipped be
    // cancelled, and a concurrent cancel cannot double-release the coupon slot.
    const cancelled = await performCancellation({
      _id: req.params.id,
      user: req.user._id,
      orderStatus: { $in: cancellable },
    });

    if (!cancelled) {
      return res
        .status(400)
        .json({ error: "This order can no longer be cancelled" });
    }

    res.json({ success: true, data: cancelled });
  } catch (error) {
    console.error("Cancel order error:", error);
    res.status(500).json({ error: "Failed to cancel order" });
  }
};