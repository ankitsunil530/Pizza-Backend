import mongoose from "mongoose";

// Append-only audit ledger for every loyalty-point movement. The authoritative
// balance lives on User.loyaltyPoints; this collection is the history/audit
// trail. `points` is always a positive integer -- `type` gives the direction:
//   earn (+)      credited when an order is delivered
//   redeem (-)    spent at checkout
//   refund (+)    redeemed points returned when an order is cancelled
//   clawback (-)  earned points removed when a delivered order is cancelled
//   adjust        reserved for a later admin phase
const loyaltyTransactionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["earn", "redeem", "refund", "clawback", "adjust"],
      required: true,
    },
    points: { type: Number, required: true, min: 0 },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    balanceAfter: { type: Number, required: true, min: 0 },
    description: { type: String, default: "" },
  },
  { timestamps: true }
);

// Idempotency: an order can be earned against at most once. Re-marking an order
// "delivered" (or a retried handler) cannot double-credit. Partial so only earn
// rows are constrained -- the same technique Order uses for razorpayPaymentId.
loyaltyTransactionSchema.index(
  { order: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      order: { $type: "objectId" },
      type: "earn",
    },
  }
);

export default mongoose.model("LoyaltyTransaction", loyaltyTransactionSchema);
