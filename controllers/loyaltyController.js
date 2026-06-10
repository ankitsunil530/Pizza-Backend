import asyncHandler from "express-async-handler";
import User from "../models/User.js";
import LoyaltyTransaction from "../models/LoyaltyTransaction.js";
import LoyaltySetting from "../models/LoyaltySetting.js";

/**
 * Always returns the single settings document, creating it with schema defaults
 * on first use. Upsert on the unique `singletonKey` so concurrent first-calls
 * cannot create two documents.
 */
export const getLoyaltySettingsDoc = async () => {
  return LoyaltySetting.findOneAndUpdate(
    { singletonKey: "default" },
    { $setOnInsert: { singletonKey: "default" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

/**
 * Pure redemption engine -- the single source of truth for redemption math,
 * mirroring couponController.evaluateCoupon. The client never sends a discount;
 * callers pass the server-computed subtotal and the user's current balance.
 *
 * Points and coupons are mutually exclusive (Phase 1), so there is no coupon
 * interaction here: a redemption is capped only by the configured percentage of
 * the subtotal and by the subtotal itself.
 *
 * Returns { ok:false, reason } or { ok:true, pointsUsed, redeemDiscount }.
 */
export const evaluateRedemption = (setting, balance, requestedPoints, subtotal) => {
  if (!setting || !setting.isEnabled) {
    return { ok: false, reason: "Loyalty redemption is currently unavailable" };
  }

  const points = Math.floor(Number(requestedPoints) || 0);
  if (points <= 0) {
    return { ok: true, pointsUsed: 0, redeemDiscount: 0 };
  }

  if (points < setting.minRedeemPoints) {
    return { ok: false, reason: `Redeem at least ${setting.minRedeemPoints} points` };
  }

  if (points > (Number(balance) || 0)) {
    return { ok: false, reason: "Insufficient points" };
  }

  const numericSubtotal = Number(subtotal) || 0;
  const rupeePerPoint = Number(setting.rupeePerPoint) || 0;

  const maxByPercent = Math.floor((numericSubtotal * setting.maxRedeemPercent) / 100);
  // Floor (not round) so the discount can never exceed the rupee value of the
  // points offered -- this keeps pointsUsed <= points for any configured rate.
  let redeemDiscount = Math.min(points * rupeePerPoint, maxByPercent, numericSubtotal);
  redeemDiscount = Math.max(0, Math.floor(redeemDiscount));

  // Only charge the points actually converted into discount, so points that hit
  // the percentage cap are not burned. Capped at `points` as a hard safety net.
  const pointsUsed =
    rupeePerPoint > 0 ? Math.min(points, Math.ceil(redeemDiscount / rupeePerPoint)) : 0;

  return { ok: true, pointsUsed, redeemDiscount };
};

/**
 * Credit earn points for a delivered order. Idempotent: the unique partial index
 * on { order, type:"earn" } guarantees a single credit even if the order is
 * re-marked delivered or the handler retries.
 */
export const awardLoyaltyForDeliveredOrder = async (order) => {
  const setting = await getLoyaltySettingsDoc();
  if (!setting.isEnabled || setting.pointsPerRupee <= 0) return;

  const base = Math.max(0, (order.subtotal || 0) - (order.discount || 0));
  const points = Math.floor(base * setting.pointsPerRupee);
  if (points <= 0) return;

  // Claim the earn first (the unique index is the idempotency gate). A duplicate
  // key means this order was already credited, so there is nothing to do.
  let ledger;
  try {
    ledger = await LoyaltyTransaction.create({
      user: order.user,
      type: "earn",
      points,
      order: order._id,
      balanceAfter: 0, // filled in once the new balance is known
      description: `Earned on order ${order._id}`,
    });
  } catch (err) {
    if (err && err.code === 11000) return; // already earned for this order
    throw err;
  }

  const updated = await User.findByIdAndUpdate(
    order.user,
    { $inc: { loyaltyPoints: points } },
    { new: true }
  );

  ledger.balanceAfter = updated ? updated.loyaltyPoints : points;
  await ledger.save();

  order.pointsEarned = points;
  await order.save();
};

/**
 * Reverse loyalty movements when an order is cancelled. Refunds points the user
 * redeemed against the order, and claws back points earned if it had been
 * delivered. Idempotent: if a refund/clawback row already exists for the order it
 * is a no-op, so re-cancelling cannot double-reverse.
 */
export const reverseLoyaltyForOrder = async (order) => {
  const alreadyReversed = await LoyaltyTransaction.exists({
    order: order._id,
    type: { $in: ["refund", "clawback"] },
  });
  if (alreadyReversed) return;

  // Refund points the user spent on this order.
  if (order.pointsRedeemed > 0) {
    const updated = await User.findByIdAndUpdate(
      order.user,
      { $inc: { loyaltyPoints: order.pointsRedeemed } },
      { new: true }
    );
    await LoyaltyTransaction.create({
      user: order.user,
      type: "refund",
      points: order.pointsRedeemed,
      order: order._id,
      balanceAfter: updated ? updated.loyaltyPoints : order.pointsRedeemed,
      description: `Refunded ${order.pointsRedeemed} redeemed points (order ${order._id} cancelled)`,
    });
  }

  // Claw back points earned on this order (delivered then cancelled), flooring
  // the balance at 0 atomically in case they were already spent.
  if (order.pointsEarned > 0) {
    const updated = await User.findOneAndUpdate(
      { _id: order.user },
      [
        {
          $set: {
            loyaltyPoints: {
              $max: [0, { $subtract: ["$loyaltyPoints", order.pointsEarned] }],
            },
          },
        },
      ],
      { new: true }
    );
    await LoyaltyTransaction.create({
      user: order.user,
      type: "clawback",
      points: order.pointsEarned,
      order: order._id,
      balanceAfter: updated ? updated.loyaltyPoints : 0,
      description: `Reverted ${order.pointsEarned} earned points (order ${order._id} cancelled)`,
    });
  }
};

/* =======================================================================
   HTTP handlers
======================================================================= */

// GET /api/loyalty/me  (user) -- balance + public settings for the checkout UI
export const getMyLoyalty = asyncHandler(async (req, res) => {
  const setting = await getLoyaltySettingsDoc();
  const user = await User.findById(req.user._id).select("loyaltyPoints");

  res.json({
    success: true,
    data: {
      balance: user ? user.loyaltyPoints : 0,
      settings: {
        isEnabled: setting.isEnabled,
        pointsPerRupee: setting.pointsPerRupee,
        rupeePerPoint: setting.rupeePerPoint,
        minRedeemPoints: setting.minRedeemPoints,
        maxRedeemPercent: setting.maxRedeemPercent,
      },
    },
  });
});

// GET /api/loyalty/me/history  (user) -- paginated ledger for the Profile page
export const getMyLoyaltyHistory = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    LoyaltyTransaction.find({ user: req.user._id })
      .sort("-createdAt")
      .skip(skip)
      .limit(limit),
    LoyaltyTransaction.countDocuments({ user: req.user._id }),
  ]);

  res.json({
    success: true,
    count: total,
    page,
    pages: Math.ceil(total / limit) || 1,
    data: items,
  });
});

// GET /api/loyalty/settings  (admin)
export const getLoyaltySettings = asyncHandler(async (req, res) => {
  const setting = await getLoyaltySettingsDoc();
  res.json({ success: true, data: setting });
});

// PUT /api/loyalty/settings  (admin) -- update earn/redeem configuration
export const updateLoyaltySettings = asyncHandler(async (req, res) => {
  const setting = await getLoyaltySettingsDoc();

  const nonNegative = ["pointsPerRupee", "rupeePerPoint", "minRedeemPoints"];
  for (const field of nonNegative) {
    if (req.body[field] !== undefined) {
      const v = Number(req.body[field]);
      if (!Number.isFinite(v) || v < 0) {
        res.status(400);
        throw new Error(`${field} must be a number >= 0`);
      }
      setting[field] = v;
    }
  }

  if (req.body.maxRedeemPercent !== undefined) {
    const v = Number(req.body.maxRedeemPercent);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      res.status(400);
      throw new Error("maxRedeemPercent must be between 0 and 100");
    }
    setting.maxRedeemPercent = v;
  }

  if (req.body.isEnabled !== undefined) {
    setting.isEnabled = Boolean(req.body.isEnabled);
  }

  await setting.save();
  res.json({ success: true, data: setting });
});
