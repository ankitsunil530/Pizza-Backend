import Topping from "../models/Topping.js";

// GET all toppings
export const getAllToppings = async (req, res) => {
  const toppings = await Topping.find({ isAvailable: true });
  res.json({
    success: true,
    count: toppings.length,
    data: toppings,
  });
};

// CREATE topping (Admin)
export const createTopping = async (req, res) => {
  const topping = await Topping.create(req.body);
  res.status(201).json({ success: true, data: topping });
};

// UPDATE topping (Admin)
export const updateTopping = async (req, res) => {
  const topping = await Topping.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });

  if (!topping) {
    return res.status(404).json({ error: "Topping not found" });
  }

  res.json({ success: true, data: topping });
};

// DELETE topping (Admin)
export const deleteTopping = async (req, res) => {
  const topping = await Topping.findById(req.params.id);

  if (!topping) {
    return res.status(404).json({ error: "Topping not found" });
  }

  await topping.deleteOne();

  res.json({ success: true, message: "Topping deleted" });
};
