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
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    items: [orderItemSchema],

    subtotal: { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },

    discount: { type: Number, default: 0 },
    couponCode: { type: String, default: null },

    // Razorpay linkage. Bound when the Razorpay order is created so that
    // payment verification can confirm a payment actually belongs to this
    // order (the signature alone only proves the payment is authentic, not
    // that it is for this order or amount). razorpayPaymentId is unique so a
    // single payment can settle exactly one order (replay protection).
    razorpayOrderId: { type: String, default: null, index: true },
    razorpayPaymentId: { type: String, default: null, unique: true, sparse: true },

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
  { timestamps: true }
);

export default mongoose.model("Order", orderSchema);