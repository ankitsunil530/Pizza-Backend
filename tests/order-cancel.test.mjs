/**
 * Cancellation regression test for issue #34 — coupon slot release on cancel
 * and user self-service cancellation.
 *
 *   node --test backend/tests/order-cancel.test.mjs
 *
 * Two parts:
 *  1) STRUCTURAL assertions tie the test to the patched source so it cannot
 *     pass against the un-patched controller/routes.
 *  2) A BEHAVIOURAL model of the ONE concurrency guarantee the fix depends on:
 *     a single-document findOneAndUpdate (status != "cancelled" -> "cancelled")
 *     is applied atomically, so N concurrent/repeated cancels of the same order
 *     release the coupon slot EXACTLY ONCE (no double-decrement, no leak).
 *     A real mongod is unavailable in this sandbox, so atomicity is modelled by
 *     a small async mutex around the doc, while real Promise scheduling provides
 *     the concurrency — the same technique used by coupon-race.test.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const ctrl = read("../controllers/orderController.js");
const routes = read("../routes/orderRoutes.js");

/* ----------------------- 1. structural assertions ----------------------- */

test("controller releases the coupon slot on cancellation", () => {
  // The release mirrors the createOrder rollback: decrement guarded by $gt: 0.
  assert.ok(
    ctrl.includes("releaseCouponForOrder"),
    "a releaseCouponForOrder helper must exist"
  );
  assert.match(
    ctrl,
    /code:\s*order\.couponCode,\s*usedCount:\s*{\s*\$gt:\s*0\s*}/,
    "release must match the coupon by code with a usedCount > 0 floor guard"
  );
  assert.ok(
    ctrl.includes("$inc: { usedCount: -1 }"),
    "release must atomically decrement usedCount"
  );
});

test("cancellation transition is atomic and exactly-once", () => {
  assert.ok(
    ctrl.includes("performCancellation"),
    "a performCancellation helper must exist"
  );
  // The atomic claim only matches a not-yet-cancelled order, so the transition
  // is observed by exactly one caller.
  assert.match(
    ctrl,
    /orderStatus:\s*{\s*\$ne:\s*"cancelled"\s*}/,
    "cancellation must claim the transition atomically (status != cancelled)"
  );
  assert.ok(
    ctrl.includes("findOneAndUpdate"),
    "the transition must use findOneAndUpdate, not a read-then-save"
  );
});

test("cancellation still reverses loyalty (earn + redeem) as before", () => {
  assert.ok(
    ctrl.includes("reverseLoyaltyForOrder"),
    "cancellation must still call reverseLoyaltyForOrder"
  );
  assert.ok(
    ctrl.includes("awardLoyaltyForDeliveredOrder"),
    "delivered transition must still award loyalty"
  );
});

test("user self-service cancel endpoint exists, scoped and status-gated", () => {
  assert.ok(ctrl.includes("cancelMyOrder"), "a cancelMyOrder controller must exist");
  // Scoped to the caller's own order (no IDOR).
  assert.match(
    ctrl,
    /_id:\s*req\.params\.id,\s*user:\s*req\.user\._id/,
    "cancelMyOrder must match { _id, user } so a user can only cancel their own order"
  );
  // Only cancellable before it leaves the kitchen.
  assert.match(
    ctrl,
    /\[\s*"placed",\s*"confirmed"\s*\]/,
    "cancelMyOrder must only allow cancellation while placed or confirmed"
  );
});

test("route exposes POST /:id/cancel for users without admin", () => {
  assert.ok(routes.includes("cancelMyOrder"), "orderRoutes must import cancelMyOrder");
  // POST /:id/cancel, protect, NO admin middleware on that line.
  const line = routes
    .split("\n")
    .find((l) => l.includes("/:id/cancel"));
  assert.ok(line, "a /:id/cancel route must be registered");
  assert.ok(line.includes("protect"), "the cancel route must be protected");
  assert.ok(!line.includes("admin"), "the cancel route must NOT require admin (it is user-facing)");
});

/* -------------------- 2. behavioural atomicity model -------------------- */

// tiny async mutex modelling single-document atomic apply
class Mutex {
  #p = Promise.resolve();
  run(fn) {
    const r = this.#p.then(() => fn());
    this.#p = r.then(
      () => {},
      () => {}
    );
    return r;
  }
}

// A model of performCancellation against an in-memory order + coupon, using the
// exact transition predicate from the controller (status != cancelled).
function makeWorld() {
  const order = { _id: "o1", orderStatus: "placed", couponCode: "SAVE10" };
  const coupon = { code: "SAVE10", usedCount: 1 };
  const mtx = new Mutex();

  async function cancelOnce() {
    // atomic: claim placed/non-cancelled -> cancelled, return pre-doc or null
    const preDoc = await mtx.run(() => {
      if (order.orderStatus !== "cancelled") {
        const snapshot = { ...order };
        order.orderStatus = "cancelled";
        return snapshot;
      }
      return null;
    });
    if (!preDoc) return null;
    // release coupon slot guarded by usedCount > 0 (also atomic per-doc)
    await mtx.run(() => {
      if (preDoc.couponCode && coupon.usedCount > 0) coupon.usedCount -= 1;
    });
    return preDoc;
  }

  return { order, coupon, cancelOnce };
}

test("concurrent cancels release the coupon slot exactly once", async () => {
  const { coupon, cancelOnce } = makeWorld();
  const results = await Promise.all(
    Array.from({ length: 50 }, () => cancelOnce())
  );
  const winners = results.filter((r) => r !== null).length;
  assert.equal(winners, 1, `exactly one cancel must win the transition, got ${winners}`);
  assert.equal(coupon.usedCount, 0, `coupon slot released exactly once, usedCount=${coupon.usedCount}`);
});

test("repeated sequential cancels never drive usedCount negative", async () => {
  const { coupon, cancelOnce } = makeWorld();
  await cancelOnce();
  await cancelOnce();
  await cancelOnce();
  assert.equal(coupon.usedCount, 0, "usedCount floors at 0 across repeated cancels");
});
