import asyncHandler from "express-async-handler";
import Coupon from "../models/Coupon.js";

/**
 * Core redemption engine -- the single source of truth for coupon math.
 * Pure function: given a coupon document and a cart subtotal, it returns
 * either { ok: false, reason } or { ok: true, discount, finalTotal }.
 *
 * All discount calculation happens here on the server. Callers never trust
 * any client-supplied amount; they pass the server-computed subtotal only.
 */
export const evaluateCoupon = (coupon, subtotal) => {
  if (!coupon) return { ok: false, reason: "Coupon not found" };
  if (!coupon.isActive) return { ok: false, reason: "This coupon is not active" };

  if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < Date.now()) {
    return { ok: false, reason: "This coupon has expired" };
  }

  if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) {
    return { ok: false, reason: "This coupon has reached its usage limit" };
  }

  const numericSubtotal = Number(subtotal) || 0;

  if (numericSubtotal < (coupon.minOrderAmount || 0)) {
    return {
      ok: false,
      reason: `Minimum order of ₹${coupon.minOrderAmount} required for this coupon`,
    };
  }

  let discount = 0;

  if (coupon.discountType === "percent") {
    discount = (numericSubtotal * coupon.discountValue) / 100;
    if (coupon.maxDiscount > 0) {
      discount = Math.min(discount, coupon.maxDiscount);
    }
  } else {
    // flat
    discount = coupon.discountValue;
  }

  // Never let the discount exceed the subtotal.
  discount = Math.min(discount, numericSubtotal);
  // Round to whole rupees to match the rest of the app's money handling.
  discount = Math.round(discount);

  const finalTotal = Math.max(0, numericSubtotal - discount);

  return { ok: true, discount, finalTotal };
};

// GET /api/coupons/available -- list available active coupons for users
export const getAvailableCoupons = asyncHandler(async (req, res) => {
  const now = new Date();
  const coupons = await Coupon.find({
    isActive: true,
    isPublic: true,
    $or: [
      { expiresAt: null },
      { expiresAt: { $gt: now } }
    ],
    $expr: {
      $or: [
        { $eq: ["$usageLimit", 0] },
        { $lt: ["$usedCount", "$usageLimit"] }
      ]
    }
  }).sort("-createdAt");
  
  res.json({ success: true, count: coupons.length, data: coupons });
});

/**
 * POST /api/coupons/validate  (user, protected)
 * Body: { code, subtotal }
 * Previews the discount for a given code + subtotal WITHOUT redeeming it.
 * The subtotal sent here is only used for the preview; the authoritative
 * discount is recomputed from the cart again at order-creation time.
 */
export const validateCoupon = asyncHandler(async (req, res) => {
  const { code, subtotal } = req.body;

  if (!code || !String(code).trim()) {
    res.status(400);
    throw new Error("Coupon code is required");
  }

  const coupon = await Coupon.findOne({ code: String(code).trim().toUpperCase() });

  const result = evaluateCoupon(coupon, subtotal);

  if (!result.ok) {
    res.status(400);
    throw new Error(result.reason);
  }

  res.json({
    success: true,
    data: {
      code: coupon.code,
      description: coupon.description,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discount: result.discount,
      finalTotal: result.finalTotal,
    },
  });
});

/* ===============================
   ADMIN CRUD (protected + admin)
================================ */

// GET /api/coupons  (admin) -- list all coupons
export const getAllCoupons = asyncHandler(async (req, res) => {
  const coupons = await Coupon.find().sort("-createdAt");
  res.json({ success: true, count: coupons.length, data: coupons });
});

// POST /api/coupons  (admin) -- create a coupon
export const createCoupon = asyncHandler(async (req, res) => {
  const {
    code,
    description,
    discountType,
    discountValue,
    minOrderAmount,
    maxDiscount,
    usageLimit,
    expiresAt,
    isActive,
    isPublic,
  } = req.body;

  if (!code || !String(code).trim()) {
    res.status(400);
    throw new Error("Coupon code is required");
  }

  if (!["percent", "flat"].includes(discountType)) {
    res.status(400);
    throw new Error("discountType must be 'percent' or 'flat'");
  }

  const numericValue = Number(discountValue);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    res.status(400);
    throw new Error("discountValue must be a positive number");
  }

  if (discountType === "percent" && numericValue > 100) {
    res.status(400);
    throw new Error("A percentage discount cannot exceed 100");
  }

  const normalizedCode = String(code).trim().toUpperCase();

  const exists = await Coupon.findOne({ code: normalizedCode });
  if (exists) {
    res.status(409);
    throw new Error("A coupon with this code already exists");
  }

  const coupon = await Coupon.create({
    code: normalizedCode,
    description: description || "",
    discountType,
    discountValue: numericValue,
    minOrderAmount: Math.max(0, Number(minOrderAmount) || 0),
    maxDiscount: Math.max(0, Number(maxDiscount) || 0),
    usageLimit: Math.max(0, Number(usageLimit) || 0),
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    isActive: isActive !== undefined ? Boolean(isActive) : true,
    isPublic: isPublic !== undefined ? Boolean(isPublic) : true,
  });

  res.status(201).json({ success: true, data: coupon });
});

// PUT /api/coupons/:id  (admin) -- update a coupon
export const updateCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) {
    res.status(404);
    throw new Error("Coupon not found");
  }

  const updatable = [
    "description",
    "discountType",
    "discountValue",
    "minOrderAmount",
    "maxDiscount",
    "usageLimit",
    "expiresAt",
    "isActive",
    "isPublic",
  ];

  if (req.body.discountType && !["percent", "flat"].includes(req.body.discountType)) {
    res.status(400);
    throw new Error("discountType must be 'percent' or 'flat'");
  }

  if (req.body.discountValue !== undefined) {
    const v = Number(req.body.discountValue);
    if (!Number.isFinite(v) || v <= 0) {
      res.status(400);
      throw new Error("discountValue must be a positive number");
    }
  }

  // Allow updating the code, but keep it normalized and unique.
  if (req.body.code !== undefined) {
    const normalizedCode = String(req.body.code).trim().toUpperCase();
    if (!normalizedCode) {
      res.status(400);
      throw new Error("Coupon code cannot be empty");
    }
    const clash = await Coupon.findOne({ code: normalizedCode, _id: { $ne: coupon._id } });
    if (clash) {
      res.status(409);
      throw new Error("Another coupon already uses this code");
    }
    coupon.code = normalizedCode;
  }

  updatable.forEach((field) => {
    if (req.body[field] !== undefined) {
      if (field === "expiresAt") {
        coupon.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
      } else {
        coupon[field] = req.body[field];
      }
    }
  });

  await coupon.save();
  res.json({ success: true, data: coupon });
});

// DELETE /api/coupons/:id  (admin) -- delete a coupon
export const deleteCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) {
    res.status(404);
    throw new Error("Coupon not found");
  }
  await coupon.deleteOne();
  res.json({ success: true, message: "Coupon deleted" });
});
