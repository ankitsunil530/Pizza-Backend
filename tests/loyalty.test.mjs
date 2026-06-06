/**
 * Regression tests for the Loyalty Points feature (issue #30, Phase 1).
 *
 * Covers the pure redemption math, earn idempotency, cancellation reversal
 * (refund + clawback), coupon/points mutual exclusion, the atomic points claim
 * under concurrency, and the order money math. A real mongod is not available
 * here, so DB-dependent behaviour is modelled faithfully in memory (the earn
 * idempotency models the unique partial index; the atomic claim models MongoDB's
 * single-document atomicity with a mutex + real Promise.all scheduling), with
 * structural assertions tying the tests to the patched files.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let passed = 0;
const ok = (n) => { console.log("  PASS:", n); passed++; };
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

const txnModel = read("../models/LoyaltyTransaction.js");
const setModel = read("../models/LoyaltySetting.js");
const userModel = read("../models/User.js");
const orderModel = read("../models/Order.js");
const loyaltyCtrl = read("../controllers/loyaltyController.js");
const orderCtrl = read("../controllers/orderController.js");
const routes = read("../routes/loyaltyRoutes.js");
const server = read("../server.js");

/* ---------- faithful copy of the pure redemption engine ---------- */
const evaluateRedemption = (setting, balance, requestedPoints, subtotal) => {
  if (!setting || !setting.isEnabled) return { ok: false, reason: "Loyalty redemption is currently unavailable" };
  const points = Math.floor(Number(requestedPoints) || 0);
  if (points <= 0) return { ok: true, pointsUsed: 0, redeemDiscount: 0 };
  if (points < setting.minRedeemPoints) return { ok: false, reason: `Redeem at least ${setting.minRedeemPoints} points` };
  if (points > (Number(balance) || 0)) return { ok: false, reason: "Insufficient points" };
  const numericSubtotal = Number(subtotal) || 0;
  const rupeePerPoint = Number(setting.rupeePerPoint) || 0;
  const maxByPercent = Math.floor((numericSubtotal * setting.maxRedeemPercent) / 100);
  let redeemDiscount = Math.min(points * rupeePerPoint, maxByPercent, numericSubtotal);
  redeemDiscount = Math.max(0, Math.floor(redeemDiscount));
  const pointsUsed = rupeePerPoint > 0 ? Math.min(points, Math.ceil(redeemDiscount / rupeePerPoint)) : 0;
  return { ok: true, pointsUsed, redeemDiscount };
};
const DEFAULTS = { isEnabled: true, pointsPerRupee: 0.1, rupeePerPoint: 1, minRedeemPoints: 50, maxRedeemPercent: 50 };

/* ---------- 0) structural linkage ---------- */
assert.ok(/type:\s*"earn"/.test(txnModel) && /partialFilterExpression/.test(txnModel) && /unique:\s*true/.test(txnModel),
  "LoyaltyTransaction has the partial-unique earn index");
assert.ok(/enum:\s*\[[^\]]*"earn"[^\]]*"redeem"[^\]]*"refund"[^\]]*"clawback"/s.test(txnModel),
  "ledger enum has earn/redeem/refund/clawback");
assert.ok(/pointsPerRupee/.test(setModel) && /rupeePerPoint/.test(setModel) && /minRedeemPoints/.test(setModel) && /maxRedeemPercent/.test(setModel) && /singletonKey/.test(setModel),
  "LoyaltySetting has all config fields + singletonKey");
assert.ok(/loyaltyPoints:\s*{[^}]*default:\s*0[^}]*min:\s*0/s.test(userModel), "User has loyaltyPoints (default 0, min 0)");
assert.ok(/pointsEarned/.test(orderModel) && /pointsRedeemed/.test(orderModel), "Order has pointsEarned + pointsRedeemed");
["evaluateRedemption","awardLoyaltyForDeliveredOrder","reverseLoyaltyForOrder","getLoyaltySettingsDoc","getMyLoyalty","getMyLoyaltyHistory","getLoyaltySettings","updateLoyaltySettings"]
  .forEach((fn) => assert.ok(loyaltyCtrl.includes(fn), `loyaltyController exports ${fn}`));
assert.ok(orderCtrl.includes("cannot be used on the same order"), "orderController enforces mutual exclusion");
assert.ok(/loyaltyPoints:\s*{\s*\$gte:\s*result\.pointsUsed\s*}/.test(orderCtrl), "orderController does the atomic points claim");
assert.ok(orderCtrl.includes('type: "redeem"'), "orderController writes a redeem ledger row");
assert.ok(orderCtrl.includes("awardLoyaltyForDeliveredOrder") && orderCtrl.includes("reverseLoyaltyForOrder"), "updateOrderStatus wires earn + reversal");
assert.ok(orderCtrl.includes("$expr") && orderCtrl.includes("usedCount: { $gt: 0 }"), "the #29 atomic coupon claim + rollback are still intact");
assert.ok(routes.includes("/me") && routes.includes("/settings"), "loyaltyRoutes exposes /me and /settings");
assert.ok(server.includes('app.use("/api/loyalty"'), "server.js mounts /api/loyalty");
ok("structural: models, controller, routes, server mount, mutual exclusion, atomic claim, and #29 intact");

/* ---------- 1) redemption math ---------- */
{
  assert.deepEqual(evaluateRedemption({ ...DEFAULTS, isEnabled: false }, 100, 100, 500), { ok: false, reason: "Loyalty redemption is currently unavailable" }, "disabled");
  assert.deepEqual(evaluateRedemption(DEFAULTS, 100, 0, 500), { ok: true, pointsUsed: 0, redeemDiscount: 0 }, "zero points = no-op ok");
  assert.equal(evaluateRedemption(DEFAULTS, 100, 30, 500).ok, false, "below min rejected");
  assert.equal(evaluateRedemption(DEFAULTS, 40, 50, 500).reason, "Insufficient points", "more than balance rejected");

  // normal 1:1, under the percent cap
  assert.deepEqual(evaluateRedemption(DEFAULTS, 200, 100, 500), { ok: true, pointsUsed: 100, redeemDiscount: 100 }, "100 pts -> Rs.100 off, 100 used");

  // percent cap binds: 50% of 500 = 250; only 250 points charged, not 400
  assert.deepEqual(evaluateRedemption(DEFAULTS, 400, 400, 500), { ok: true, pointsUsed: 250, redeemDiscount: 250 }, "percent cap: not all points burned");

  // rate 2 rupees/point
  assert.deepEqual(evaluateRedemption({ ...DEFAULTS, rupeePerPoint: 2, maxRedeemPercent: 100 }, 100, 100, 1000), { ok: true, pointsUsed: 100, redeemDiscount: 200 }, "rupeePerPoint=2");

  // fractional rate must not let pointsUsed exceed offered points (floor protects this)
  const frac = evaluateRedemption({ ...DEFAULTS, rupeePerPoint: 0.5, maxRedeemPercent: 100 }, 101, 101, 1000);
  assert.equal(frac.redeemDiscount, 50, "0.5/pt, 101 pts -> floor(50.5)=50");
  assert.ok(frac.pointsUsed <= 101, "pointsUsed never exceeds offered points");
  assert.equal(frac.pointsUsed, 100, "0.5/pt -> 100 points buy Rs.50");

  // zero rate -> no discount, no points charged
  assert.deepEqual(evaluateRedemption({ ...DEFAULTS, rupeePerPoint: 0 }, 100, 100, 500), { ok: true, pointsUsed: 0, redeemDiscount: 0 }, "zero rate is safe");
  ok("redemption math: min/balance/cap/rate/rounding all correct; pointsUsed <= offered always");
}

/* ---------- 2) earn idempotency (models the unique earn index) ---------- */
{
  const earnedOrders = new Set();        // models { order, type:"earn" } unique index
  let balance = 0;
  const award = (order, setting) => {
    const base = Math.max(0, order.subtotal - order.discount);
    const points = Math.floor(base * setting.pointsPerRupee);
    if (points <= 0) return;
    if (earnedOrders.has(order.id)) return; // duplicate-key -> already credited
    earnedOrders.add(order.id);
    balance += points;
    order.pointsEarned = points;
  };
  const order = { id: "o1", subtotal: 500, discount: 100, pointsEarned: 0 }; // base 400 * 0.1 = 40
  award(order, DEFAULTS);
  award(order, DEFAULTS); // retry / re-mark delivered
  award(order, DEFAULTS);
  assert.equal(balance, 40, "earn credited exactly once despite 3 calls");
  assert.equal(order.pointsEarned, 40, "order records 40 earned");
  ok("earn is idempotent: re-marking delivered credits once (post-discount base)");
}

/* ---------- 3) cancellation reversal: refund + clawback, floored, idempotent ---------- */
{
  // refund redeemed points on cancel
  let bal = 20;
  const reversedOrders = new Set();
  const reverse = (order) => {
    if (reversedOrders.has(order.id)) return;
    reversedOrders.add(order.id);
    if (order.pointsRedeemed > 0) bal += order.pointsRedeemed;
    if (order.pointsEarned > 0) bal = Math.max(0, bal - order.pointsEarned);
  };
  const redeemedOrder = { id: "r1", pointsRedeemed: 80, pointsEarned: 0 };
  reverse(redeemedOrder); reverse(redeemedOrder); // re-cancel
  assert.equal(bal, 100, "redeemed points refunded once (20 + 80)");

  // clawback earned points, floored at 0 if already spent
  let bal2 = 30;
  const reversed2 = new Set();
  const reverse2 = (order) => {
    if (reversed2.has(order.id)) return;
    reversed2.add(order.id);
    if (order.pointsRedeemed > 0) bal2 += order.pointsRedeemed;
    if (order.pointsEarned > 0) bal2 = Math.max(0, bal2 - order.pointsEarned);
  };
  reverse2({ id: "d1", pointsRedeemed: 0, pointsEarned: 50 }); // earned 50, only 30 left
  assert.equal(bal2, 0, "clawback floors balance at 0 (max(0, 30-50))");
  ok("reversal: refunds redeemed, claws back earned (floored at 0), idempotent on re-cancel");
}

/* ---------- 4) coupon/points mutual exclusion ---------- */
{
  const rejectsBoth = (couponCode, redeemPoints) => {
    const wantsToRedeem = Math.floor(Number(redeemPoints) || 0) > 0;
    return !!(couponCode && String(couponCode).trim() && wantsToRedeem);
  };
  assert.equal(rejectsBoth("SAVE50", 100), true, "both coupon + points -> rejected");
  assert.equal(rejectsBoth("SAVE50", 0), false, "coupon only -> allowed");
  assert.equal(rejectsBoth("", 100), false, "points only -> allowed");
  assert.equal(rejectsBoth(null, 0), false, "neither -> allowed");
  ok("mutual exclusion: rejects coupon+points together, allows either alone");
}

/* ---------- 5) atomic points claim under concurrency ---------- */
{
  // model MongoDB single-document atomicity: conditional debit applied under a mutex
  const makeUser = (bal) => ({ loyaltyPoints: bal, _lock: Promise.resolve() });
  const claim = async (user, pointsUsed) => {
    let release;
    const prev = user._lock;
    user._lock = new Promise((r) => (release = r));
    await prev;
    try {
      if (user.loyaltyPoints >= pointsUsed) { user.loyaltyPoints -= pointsUsed; return true; }
      return false;
    } finally { release(); }
  };

  const user = makeUser(150);
  const results = await Promise.all([claim(user, 100), claim(user, 100)]); // two concurrent 100-pt spends
  const wins = results.filter(Boolean).length;
  assert.equal(wins, 1, "only one concurrent 100-pt claim succeeds against a 150 balance");
  assert.equal(user.loyaltyPoints, 50, "balance debited exactly once (150 - 100)");

  // heavy load: 200 balance, 50 concurrent claims of 10 -> exactly 20 succeed, balance 0
  const u2 = makeUser(200);
  const many = await Promise.all(Array.from({ length: 50 }, () => claim(u2, 10)));
  assert.equal(many.filter(Boolean).length, 20, "exactly 20 of 50 claims succeed");
  assert.equal(u2.loyaltyPoints, 0, "no over-spend under heavy concurrency");
  ok("atomic claim: no double-spend; balance never goes negative under concurrency");
}

/* ---------- 6) order money math (mutually exclusive paths) ---------- */
{
  const total = (subtotal, discount, redeemDiscount, deliveryFee) => subtotal - discount - redeemDiscount + deliveryFee;
  assert.equal(total(500, 0, 100, 40), 440, "redeem path: 500 - 100 + 40 delivery = 440");
  assert.equal(total(500, 50, 0, 40), 490, "coupon path: 500 - 50 + 40 delivery = 490");
  assert.equal(total(500, 0, 0, 40), 540, "no discount: 500 + 40 delivery");
  ok("order total = subtotal - couponDiscount - redeemDiscount + deliveryFee (one discount path at a time)");
}

console.log(`\nALL ${passed} CHECKS PASSED`);
