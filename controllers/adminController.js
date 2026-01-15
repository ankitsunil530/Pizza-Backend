import Order from "../models/Order.js";
import User from "../models/User.js";

export const getAdminStats = async (req, res) => {
  const orders = await Order.countDocuments();
  const users = await User.countDocuments();

  const revenueAgg = await Order.aggregate([
    { $match: { paymentStatus: "paid" } },
    { $group: { _id: null, total: { $sum: "$totalAmount" } } },
  ]);

  const pendingPayments = await Order.countDocuments({ paymentStatus: "pending" });

  res.json({
    orders,
    users,
    revenue: revenueAgg[0]?.total || 0,
    pendingPayments,
  });
};
