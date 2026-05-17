import Order from "../models/Order.js";
import User from "../models/User.js";
import Pizza from "../models/Pizza.js";
import Topping from "../models/Topping.js";
import { getRazorpayMode } from "../config/razorpay.js";

const startOfDay = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const startOfMonth = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), 1);
const daysAgo = (days) => {
  const date = startOfDay();
  date.setDate(date.getDate() - days);
  return date;
};

const sumRevenue = async (match = {}) => {
  const [result] = await Order.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: "$totalAmount" } } },
  ]);
  return result?.total || 0;
};

const countByField = async (field) => {
  const rows = await Order.aggregate([
    { $group: { _id: `$${field}`, count: { $sum: 1 }, amount: { $sum: "$totalAmount" } } },
    { $sort: { count: -1 } },
  ]);

  return rows.reduce((acc, row) => {
    acc[row._id || "unknown"] = {
      count: row.count,
      amount: row.amount,
    };
    return acc;
  }, {});
};

export const getAdminStats = async (req, res) => {
  try {
    const today = startOfDay();
    const month = startOfMonth();
    const lastSevenDays = daysAgo(6);
    const paidMatch = { paymentStatus: { $in: ["paid", "cod"] } };

    const [
      orders,
      users,
      activeUsers,
      pizzas,
      availablePizzas,
      toppings,
      grossRevenue,
      todayRevenue,
      monthlyRevenue,
      pendingPayments,
      paidOrders,
      codOrders,
      deliveredOrders,
      cancelledOrders,
      recentOrders,
      topPizzas,
      revenueSeries,
      orderStatusBreakdown,
      paymentBreakdown,
    ] = await Promise.all([
      Order.countDocuments(),
      User.countDocuments(),
      User.countDocuments({ status: "active" }),
      Pizza.countDocuments(),
      Pizza.countDocuments({ isAvailable: true }),
      Topping.countDocuments({ isAvailable: true }),
      sumRevenue(paidMatch),
      sumRevenue({ ...paidMatch, createdAt: { $gte: today } }),
      sumRevenue({ ...paidMatch, createdAt: { $gte: month } }),
      Order.countDocuments({ paymentStatus: "pending" }),
      Order.countDocuments({ paymentStatus: "paid" }),
      Order.countDocuments({ paymentStatus: "cod" }),
      Order.countDocuments({ orderStatus: "delivered" }),
      Order.countDocuments({ orderStatus: "cancelled" }),
      Order.find().populate("user", "name email").sort("-createdAt").limit(6),
      Order.aggregate([
        { $match: paidMatch },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.name",
            quantity: { $sum: "$items.qty" },
            revenue: { $sum: { $multiply: ["$items.price", "$items.qty"] } },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 5 },
      ]),
      Order.aggregate([
        { $match: { ...paidMatch, createdAt: { $gte: lastSevenDays } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            revenue: { $sum: "$totalAmount" },
            orders: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      countByField("orderStatus"),
      countByField("paymentStatus"),
    ]);

    const averageOrderValue = paidOrders + codOrders > 0 ? Math.round(grossRevenue / (paidOrders + codOrders)) : 0;
    const netWorth = grossRevenue;
    const conversionRate = orders > 0 ? Math.round(((paidOrders + codOrders) / orders) * 100) : 0;

    res.json({
      success: true,
      data: {
        totals: {
          orders,
          users,
          activeUsers,
          pizzas,
          availablePizzas,
          toppings,
          paidOrders,
          codOrders,
          pendingPayments,
          deliveredOrders,
          cancelledOrders,
        },
        money: {
          grossRevenue,
          revenue: grossRevenue,
          netRevenue: grossRevenue,
          netWorth,
          todayRevenue,
          monthlyRevenue,
          averageOrderValue,
        },
        performance: {
          conversionRate,
          fulfillmentRate: orders > 0 ? Math.round((deliveredOrders / orders) * 100) : 0,
          cancellationRate: orders > 0 ? Math.round((cancelledOrders / orders) * 100) : 0,
        },
        breakdowns: {
          orderStatus: orderStatusBreakdown,
          paymentStatus: paymentBreakdown,
        },
        recentOrders,
        topPizzas,
        revenueSeries,
        razorpay: getRazorpayMode(),
      },
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    res.status(500).json({ error: "Failed to load admin dashboard stats" });
  }
};
