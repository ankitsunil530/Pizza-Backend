import mongoose from "mongoose";

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },

    description: { type: String, default: "" },

    discountType: {
      type: String,
      enum: ["percent", "flat"],
      required: true,
    },

    // For "percent": a value of 10 means 10% off.
    // For "flat": a value of 100 means flat 100 off.
    discountValue: {
      type: Number,
      required: true,
      min: 0,
    },

    // Minimum cart subtotal required for the coupon to apply.
    minOrderAmount: { type: Number, default: 0, min: 0 },

    // Caps the rupee discount for "percent" coupons (0 = no cap).
    maxDiscount: { type: Number, default: 0, min: 0 },

    // Global redemption cap across all users (0 = unlimited).
    usageLimit: { type: Number, default: 0, min: 0 },

    // How many times this coupon has been successfully redeemed.
    usedCount: { type: Number, default: 0, min: 0 },

    expiresAt: { type: Date, default: null },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model("Coupon", couponSchema);
