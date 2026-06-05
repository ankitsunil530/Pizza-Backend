import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema({
  pizzaId: { type: mongoose.Schema.Types.ObjectId, ref: "Pizza" },
  name: String,
  image: String,
  size: Object,
  crust: Object,
  toppings: Array,
  price: Number,
  qty: Number,
});

const orderSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    items: [orderItemSchema],

    subtotal: {
      type: Number,
      default: 0,
    },

    deliveryFee: {
      type: Number,
      default: 0,
    },

    totalAmount: {
      type: Number,
      required: true,
    },

    discount: {
      type: Number,
      default: 0,
    },

    couponCode: {
      type: String,
      default: null,
    },

    // Razorpay linkage
    razorpayOrderId: {
      type: String,
      index: true,
    },

    razorpayPaymentId: {
      type: String,
    },

    paymentMethod: {
      type: String,
      enum: ["cod", "online"],
      default: "cod",
    },

    paymentStatus: {
      type: String,
      default: "pending", // pending, paid, cod
    },

    orderStatus: {
      type: String,
      default: "placed", // placed, confirmed, preparing, out_for_delivery, delivered, cancelled
    },

    address: {
      type: String,
      required: true,
    },

    phone: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Unique Razorpay payment IDs only when present
orderSchema.index(
  { razorpayPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      razorpayPaymentId: {
        $exists: true,
        $type: "string",
      },
    },
  }
);

export default mongoose.model("Order", orderSchema);