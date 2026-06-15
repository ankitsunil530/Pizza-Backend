import asyncHandler from "express-async-handler";
import mongoose from "mongoose";
import Pizza from "../models/Pizza.js";

// GET all pizzas
export const getAllPizzas = asyncHandler(async (req, res) => {
  const pizzas = await Pizza.find();
  res.json({
    success: true,
    count: pizzas.length,
    data: pizzas,
  });
});

// GET single pizza
export const getPizzaById = asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid pizza id" });
  }

  const pizza = await Pizza.findById(req.params.id);

  if (!pizza) {
    return res.status(404).json({ error: "Pizza not found" });
  }

  res.json({ success: true, data: pizza });
});

// CREATE pizza (Admin only)
export const createPizza = asyncHandler(async (req, res) => {
  const pizza = await Pizza.create(req.body);
  res.status(201).json({ success: true, data: pizza });
});

// ADD / UPDATE review (Logged-in users)
export const addPizzaReview = async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const numericRating = Number(rating);

    if (!numericRating || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ error: "Please select a rating between 1 and 5" });
    }

    if (!comment || comment.trim().length < 3) {
      return res.status(400).json({ error: "Review comment must be at least 3 characters" });
    }

    const pizza = await Pizza.findById(req.params.id);
    if (!pizza) return res.status(404).json({ error: "Pizza not found" });

    const existingReview = pizza.reviews.find((review) => review.user.toString() === req.user._id.toString());

    if (existingReview) {
      existingReview.rating = numericRating;
      existingReview.comment = comment.trim();
      existingReview.name = req.user.name;
    } else {
      pizza.reviews.push({
        user: req.user._id,
        name: req.user.name,
        rating: numericRating,
        comment: comment.trim(),
      });
    }

    pizza.numReviews = pizza.reviews.length;
    pizza.rating = pizza.reviews.reduce((sum, review) => sum + review.rating, 0) / pizza.reviews.length;

    await pizza.save();

    res.status(existingReview ? 200 : 201).json({
      success: true,
      message: existingReview ? "Review updated" : "Review added",
      data: pizza,
    });
  } catch (error) {
    console.error("Pizza review error:", error);
    res.status(500).json({ error: "Failed to save review" });
  }
};
