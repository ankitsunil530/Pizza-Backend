import Cart from "../models/Cart.js";

// ================= GET CART =================
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

// ================= ADD TO CART =================
export const addToCart = async (req, res) => {
  try {
    const { item } = req.body;

    let cart = await Cart.findOne({ user: req.user._id });

    if (!cart) {
      cart = await Cart.create({ user: req.user._id, items: [] });
    }

    // 🔍 Check if same pizza config already exists
    const existingItem = cart.items.find(
      (i) =>
        i.pizzaId.toString() === item.pizzaId &&
        i.size?.name === item.size?.name &&
        i.crust?.name === item.crust?.name &&
        JSON.stringify(i.toppings.map(t => t._id).sort()) ===
          JSON.stringify(item.toppings.map(t => t._id).sort())
    );

    if (existingItem) {
      existingItem.qty += 1;
    } else {
      cart.items.push(item);
    }

    await cart.save();

    res.json({ success: true, data: cart });
  } catch (error) {
    console.error("Add to cart error:", error);
    res.status(500).json({ error: "Failed to add item to cart" });
  }
};

// ================= REMOVE ITEM =================
export const removeFromCart = async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user._id });

    if (!cart) {
      return res.status(404).json({ error: "Cart not found" });
    }

    cart.items = cart.items.filter(
      (i) => i._id.toString() !== req.params.id
    );

    await cart.save();

    res.json({ success: true, data: cart });
  } catch (error) {
    console.error("Remove from cart error:", error);
    res.status(500).json({ error: "Failed to remove item" });
  }
};

// ================= CLEAR CART (for after payment) =================
export const clearCart = async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user._id });

    if (cart) {
      cart.items = [];
      await cart.save();
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Clear cart error:", error);
    res.status(500).json({ error: "Failed to clear cart" });
  }
};
