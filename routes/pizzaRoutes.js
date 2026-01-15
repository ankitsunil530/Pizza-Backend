import express from "express";
import {
  getAllPizzas,
  getPizzaById,
  createPizza,
} from "../controllers/pizzaController.js";
import admin from "../middlewares/adminMiddleware.js";
import protect from "../middlewares/authWebToken.js";



const router = express.Router();

router.get("/", getAllPizzas);
router.get("/:id", getPizzaById);

// Admin route
router.post("/", protect, admin, createPizza);

export default router;
