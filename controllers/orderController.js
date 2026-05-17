import Order from "../models/Order.js";
import Cart from "../models/Cart.js";

export const createOrder = async (req, res) => {
  try {
    const { address, phone, paymentMethod = "cod", deliveryFee = 0 } = req.body;

    if (!address || address.trim().length < 12) {
      return res.status(400).json({ error: "Complete delivery address is required" });
    }

    if (!/^\d{10}$/.test(String(phone || ""))) {
      return res.status(400).json({ error: "Valid 10-digit phone number is required" });
    }

    if (!["cod", "online"].includes(paymentMethod)) {
      return res.status(400).json({ error: "Invalid payment method" });
    }

    const cart = await Cart.findOne({ user: req.user._id });

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);
    const safeDeliveryFee = Math.max(0, Number(deliveryFee) || 0);
    const totalAmount = subtotal + safeDeliveryFee;

    const order = await Order.create({
      user: req.user._id,
      items: cart.items.map((item) => item.toObject()),
      subtotal,
      deliveryFee: safeDeliveryFee,
      totalAmount,
      address: address.trim(),
      phone: String(phone),
      paymentMethod,
      paymentStatus: paymentMethod === "cod" ? "cod" : "pending",
      orderStatus: "placed",
    });

    if (paymentMethod === "cod") {
      cart.items = [];
      await cart.save();
    }

    res.status(201).json({
      success: true,
      data: order,
    });
  } catch (error) {
    console.error("Create order error:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
};

export const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id }).sort("-createdAt");
    res.json({ success: true, data: orders });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
};

export const getOrderById = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== "admin") query.user = req.user._id;

    const order = await Order.findOne(query).populate("user", "name email");
    if (!order) return res.status(404).json({ error: "Order not found" });

    res.json({ success: true, data: order });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch order" });
  }
};

export const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find().populate("user", "name email").sort("-createdAt");
    res.json({ success: true, data: orders });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
};

export const updateOrderStatus = async (req, res) => {
  try {
    const allowedStatuses = ["placed", "confirmed", "preparing", "out_for_delivery", "delivered", "cancelled"];
    if (!allowedStatuses.includes(req.body.status)) {
      return res.status(400).json({ error: "Invalid order status" });
    }

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
