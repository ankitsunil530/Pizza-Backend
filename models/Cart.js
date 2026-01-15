import mongoose from "mongoose";

const cartItemSchema = new mongoose.Schema({
  pizzaId: { type: mongoose.Schema.Types.ObjectId, ref: "Pizza" },
  name: String,
  size: Object,
  crust: Object,
  toppings: Array,
  price: Number,
  qty: { type: Number, default: 1 },
});

const cartSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", unique: true },
    items: [cartItemSchema],
  },
  { timestamps: true }
);

export default mongoose.model("Cart", cartSchema);
