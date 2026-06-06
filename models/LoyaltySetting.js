import mongoose from "mongoose";

// Admin-editable configuration for the loyalty programme, stored as a single
// document (coupons are already admin-editable DB documents, so this follows the
// same pattern rather than hard-coded constants). `singletonKey` is unique, so
// there is always exactly one settings document.
const loyaltySettingSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, default: "default", unique: true },

    // Earn: points per rupee of post-discount food spend. 0.1 => 1 pt per Rs.10.
    pointsPerRupee: { type: Number, default: 0.1, min: 0 },

    // Redeem: rupee value of one point. 1 => 1 pt is worth Rs.1.
    rupeePerPoint: { type: Number, default: 1, min: 0 },

    // Minimum points a user must spend in a single redemption.
    minRedeemPoints: { type: Number, default: 50, min: 0 },

    // Cap a single redemption to this percentage of the cart subtotal.
    maxRedeemPercent: { type: Number, default: 50, min: 0, max: 100 },

    isEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model("LoyaltySetting", loyaltySettingSchema);
