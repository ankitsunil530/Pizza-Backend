import Pizza from "../models/Pizza.js";

// GET all pizzas
export const getAllPizzas = async (req, res) => {
  const pizzas = await Pizza.find();
  res.json({
    success: true,
    count: pizzas.length,
    data: pizzas,
  });
};

// GET single pizza
export const getPizzaById = async (req, res) => {
  const pizza = await Pizza.findById(req.params.id);

  if (!pizza) {
    return res.status(404).json({ error: "Pizza not found" });
  }

  res.json({ success: true, data: pizza });
};

// CREATE pizza (Admin only)
export const createPizza = async (req, res) => {
  const pizza = await Pizza.create(req.body);
  res.status(201).json({ success: true, data: pizza });
};
