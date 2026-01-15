import Order from "../models/Order.js";
import Cart from "../models/Cart.js";

// ================= CREATE ORDER =================
export const createOrder = async (req, res) => {
  try {
    const { address } = req.body;

    const cart = await Cart.findOne({ user: req.user._id });

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const totalAmount = cart.items.reduce(
      (sum, item) => sum + item.price * item.qty,
      0
    );

    const order = await Order.create({
      user: req.user._id,
      items: cart.items,
      totalAmount,
      address,
      paymentStatus: "pending",   // ✅ important
      orderStatus: "placed",      // optional clarity
    });

    // ⚠️ Option 1 (simple): clear cart now
    cart.items = [];
    await cart.save();

    // ⚠️ Option 2 (better): clear cart AFTER payment success
    // (we will handle this in payment verification later)

    res.status(201).json({
      success: true,
      data: order,
    });

  } catch (error) {
    console.error("Create order error:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
};

// ================= USER ORDERS =================
export const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id }).sort("-createdAt");
    res.json({ success: true, data: orders });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
};

// ================= ADMIN: ALL ORDERS =================
export const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find().populate("user", "name email");
    res.json({ success: true, data: orders });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
};

// ================= ADMIN: UPDATE STATUS =================
export const updateOrderStatus = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    order.orderStatus = req.body.status;
    await order.save();

    res.json({ success: true, data: order });
  } catch (error) {
    res.status(500).json({ error: "Failed to update order status" });
  }
};
