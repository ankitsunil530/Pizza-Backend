import mongoose from "mongoose";

const optionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
});

const pizzaSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String },
    image: { type: String },

    basePrice: { type: Number, required: true },

    sizes: [optionSchema],   // small, medium, large
    crusts: [optionSchema],  // thin, cheese burst, etc.

    isAvailable: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model("Pizza", pizzaSchema);
