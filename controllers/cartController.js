import Cart from "../models/Cart.js";

export const getCart = async (req, res) => {
  try {
    let cart = await Cart.findOne({ user: req.user._id });

    if (!cart) {
      cart = await Cart.create({ user: req.user._id, items: [] });
    }

    res.json({ success: true, data: cart });
  } catch (error) {
    console.error("Get cart error:", error);
    res.status(500).json({ error: "Failed to get cart" });
  }
};

export const addToCart = async (req, res) => {
  try {
    const { item } = req.body;

    if (!item?.pizzaId || !item?.name || !item?.size || !item?.crust || !item?.price) {
      return res.status(400).json({ error: "Invalid cart item" });
    }

    let cart = await Cart.findOne({ user: req.user._id });

    if (!cart) {
      cart = await Cart.create({ user: req.user._id, items: [] });
    }

    const incomingToppings = (item.toppings || []).map((topping) => topping._id || topping.name).sort();
    const existingItem = cart.items.find((cartItem) => {
      const cartToppings = (cartItem.toppings || []).map((topping) => topping._id || topping.name).sort();
      return (
        cartItem.pizzaId?.toString() === item.pizzaId &&
        cartItem.size?.name === item.size?.name &&
        cartItem.crust?.name === item.crust?.name &&
        JSON.stringify(cartToppings) === JSON.stringify(incomingToppings)
      );
    });

    if (existingItem) {
      existingItem.qty += Number(item.qty) || 1;
    } else {
      cart.items.push({ ...item, qty: Number(item.qty) || 1 });
    }

    await cart.save();

    res.json({ success: true, data: cart });
  } catch (error) {
    console.error("Add to cart error:", error);
    res.status(500).json({ error: "Failed to add item to cart" });
  }
};

export const updateCartItemQuantity = async (req, res) => {
  try {
    const qty = Number(req.body.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
      return res.status(400).json({ error: "Quantity must be between 1 and 10" });
    }

    const cart = await Cart.findOne({ user: req.user._id });
    if (!cart) return res.status(404).json({ error: "Cart not found" });

    const item = cart.items.id(req.params.id);
    if (!item) return res.status(404).json({ error: "Cart item not found" });

    item.qty = qty;
    await cart.save();

    res.json({ success: true, data: cart });
  } catch (error) {
    console.error("Update cart quantity error:", error);
    res.status(500).json({ error: "Failed to update quantity" });
  }
};

export const removeFromCart = async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user._id });

    if (!cart) {
      return res.status(404).json({ error: "Cart not found" });
    }

    cart.items = cart.items.filter((item) => item._id.toString() !== req.params.id);
    await cart.save();

    res.json({ success: true, data: cart });
  } catch (error) {
    console.error("Remove from cart error:", error);
    res.status(500).json({ error: "Failed to remove item" });
  }
};

export const clearCart = async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user._id });

    if (cart) {
      cart.items = [];
      await cart.save();
    }

    res.json({ success: true, data: cart || { items: [] } });
  } catch (error) {
    console.error("Clear cart error:", error);
    res.status(500).json({ error: "Failed to clear cart" });
  }
};
