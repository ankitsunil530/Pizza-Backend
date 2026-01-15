import express from "express";
import { getCart, addToCart, removeFromCart, clearCart } from "../controllers/cartController.js";
import protect from "../middlewares/authWebToken.js";


const router = express.Router();

router.get("/", protect, getCart);
router.post("/", protect, addToCart);
router.delete("/:id", protect, removeFromCart);
router.delete("/clear", protect, clearCart);
export default router;
