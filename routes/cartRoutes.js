import express from "express";
import {
  getCart,
  addToCart,
  removeFromCart,
  clearCart,
  updateCartItemQuantity,
} from "../controllers/cartController.js";
import protect from "../middlewares/authWebToken.js";

const router = express.Router();

router.get("/", protect, getCart);
router.post("/", protect, addToCart);
router.delete("/clear", protect, clearCart);
router.patch("/:id", protect, updateCartItemQuantity);
router.delete("/:id", protect, removeFromCart);

export default router;
