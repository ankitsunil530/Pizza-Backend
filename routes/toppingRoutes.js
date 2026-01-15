import express from "express";
import {
  getAllToppings,
  createTopping,
  updateTopping,
  deleteTopping,
} from "../controllers/toppingController.js";
import admin from "../middlewares/adminMiddleware.js";
import protect from "../middlewares/authWebToken.js";



const router = express.Router();

// Public
router.get("/", getAllToppings);

// Admin
router.post("/", protect, admin, createTopping);
router.put("/:id", protect, admin, updateTopping);
router.delete("/:id", protect, admin, deleteTopping);

export default router;
