import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema({
  pizzaId: { type: mongoose.Schema.Types.ObjectId, ref: "Pizza" },
  name: String,
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

    totalAmount: { type: Number, required: true },

    paymentStatus: {
      type: String,
      default: "pending", // pending, paid
    },

    orderStatus: {
      type: String,
      default: "placed", // placed, preparing, delivered, cancelled
    },

    address: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Order", orderSchema);
