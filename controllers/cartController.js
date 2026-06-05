import mongoose from "mongoose";
import Cart from "../models/Cart.js";
import Pizza from "../models/Pizza.js";
import Topping from "../models/Topping.js";

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

/**
 * Pure unit-price calculation. Mirrors the frontend formula in
 * PizzaDetails.jsx exactly:
 *   basePrice + size.price + crust.price + Σ(topping.price)
 * All inputs here are server-resolved (never the client's numbers), so the
 * result is authoritative. Exported so it can be unit-tested in isolation.
 */
export function computeUnitPrice(basePrice, size, crust, toppings) {
  const toppingTotal = (toppings || []).reduce(
    (sum, t) => sum + (Number(t?.price) || 0),
    0
  );
  return (
    (Number(basePrice) || 0) +
    (Number(size?.price) || 0) +
    (Number(crust?.price) || 0) +
    toppingTotal
  );
}

export const addToCart = async (req, res) => {
  try {
    const { item } = req.body;

    // We need enough to identify the pizza and its chosen options. The client
    // price is intentionally NOT required — it is recomputed server-side below.
    if (!item?.pizzaId || !item?.size?.name || !item?.crust?.name) {
      return res.status(400).json({ error: "Invalid cart item" });
    }

    // Reject demo/garbage ids cleanly instead of letting findById throw.
    if (!mongoose.Types.ObjectId.isValid(item.pizzaId)) {
      return res.status(400).json({ error: "Invalid pizza reference" });
    }

    const pizza = await Pizza.findById(item.pizzaId);
    if (!pizza) {
      return res.status(404).json({ error: "Pizza not found" });
    }
    if (pizza.isAvailable === false) {
      return res.status(400).json({ error: "This pizza is currently unavailable" });
    }

    // Resolve size and crust against the pizza's own options, by name, using
    // the SERVER's price for each (the client's price field is discarded).
    const resolvedSize = (pizza.sizes || []).find((s) => s.name === item.size.name);
    if (!resolvedSize) {
      return res.status(400).json({ error: "Invalid size for this pizza" });
    }
    const resolvedCrust = (pizza.crusts || []).find((c) => c.name === item.crust.name);
    if (!resolvedCrust) {
      return res.status(400).json({ error: "Invalid crust for this pizza" });
    }

    // Resolve every topping from the Topping collection (by id when it's a real
    // ObjectId, else by name) so each price is server-controlled. Any topping we
    // can't find is rejected rather than trusted.
    const incomingToppings = Array.isArray(item.toppings) ? item.toppings : [];
    const resolvedToppings = [];
    for (const t of incomingToppings) {
      let doc = null;
      if (t?._id && mongoose.Types.ObjectId.isValid(t._id)) {
        doc = await Topping.findById(t._id);
      }
      if (!doc && t?.name) {
        doc = await Topping.findOne({ name: t.name });
      }
      if (!doc) {
        return res
          .status(400)
          .json({ error: `Invalid topping: ${t?.name || "unknown"}` });
      }
      if (doc.isAvailable === false) {
        return res
          .status(400)
          .json({ error: `Topping unavailable: ${doc.name}` });
      }
      resolvedToppings.push({ _id: doc._id, name: doc.name, price: doc.price });
    }

    // Trusted price — computed only from server data.
    const price = computeUnitPrice(
      pizza.basePrice,
      resolvedSize,
      resolvedCrust,
      resolvedToppings
    );

    // Rebuild the cart item entirely from server-side values. Nothing the client
    // sent about price/name/image is stored.
    const trustedItem = {
      pizzaId: pizza._id,
      name: pizza.name,
      image: pizza.image,
      size: { name: resolvedSize.name, price: resolvedSize.price },
      crust: { name: resolvedCrust.name, price: resolvedCrust.price },
      toppings: resolvedToppings,
      price,
      qty: Number(item.qty) || 1,
    };

    let cart = await Cart.findOne({ user: req.user._id });

    if (!cart) {
      cart = await Cart.create({ user: req.user._id, items: [] });
    }

    // Same de-duplication rule as before, using the trusted item's fields.
    const trustedToppingKey = trustedItem.toppings
      .map((t) => t._id?.toString() || t.name)
      .sort();
    const existingItem = cart.items.find((cartItem) => {
      const cartToppings = (cartItem.toppings || [])
        .map((t) => t._id?.toString() || t.name)
        .sort();
      return (
        cartItem.pizzaId?.toString() === trustedItem.pizzaId.toString() &&
        cartItem.size?.name === trustedItem.size.name &&
        cartItem.crust?.name === trustedItem.crust.name &&
        JSON.stringify(cartToppings) === JSON.stringify(trustedToppingKey)
      );
    });

    if (existingItem) {
      existingItem.qty += trustedItem.qty;
    } else {
      cart.items.push(trustedItem);
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
