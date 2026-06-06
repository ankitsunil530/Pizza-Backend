/**
 * Concurrency regression test for coupon usageLimit enforcement (issue #27).
 *
 * A real mongod is not available in this sandbox, so this test models the ONE
 * guarantee the fix depends on: MongoDB applies a single-document
 * findOneAndUpdate (filter + $inc) ATOMICALLY -- no two concurrent updates can
 * interleave within one document. That invariant is implemented here by a small
 * async mutex around the atomic ops, while real Promise scheduling provides the
 * concurrency. The conditional filter evaluated is byte-identical to the one in
 * controllers/orderController.js (asserted below), and uses the same $expr/$lt
 * construct already run against real Mongo by getAvailableCoupons in this repo.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

/* ---------- tiny async mutex (models single-doc atomic apply) ---------- */
class Mutex {
  #p = Promise.resolve();
  run(fn) {
    const r = this.#p.then(() => fn());
    this.#p = r.then(() => {}, () => {});
    return r;
  }
}

/* ---------- faithful evaluator for the filter we use ---------- */
function matches(doc, filter) {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "_id") { if (String(doc._id) !== String(v)) return false; }
    else if (k === "$or") { if (!v.some((sub) => matches(doc, sub))) return false; }
    else if (k === "$expr") { if (!evalExpr(doc, v)) return false; }
    else if (v && typeof v === "object" && "$gt" in v) { if (!(doc[k] > v.$gt)) return false; }
    else { if (doc[k] !== v) return false; }
  }
  return true;
}
function evalExpr(doc, expr) {
  if (expr.$lt) { const [a, b] = expr.$lt.map((x) => resolve(doc, x)); return a < b; }
  if (expr.$eq) { const [a, b] = expr.$eq.map((x) => resolve(doc, x)); return a === b; }
  if (expr.$or) return expr.$or.some((e) => evalExpr(doc, e));
  throw new Error("unsupported expr");
}
const resolve = (doc, x) => (typeof x === "string" && x.startsWith("$") ? doc[x.slice(1)] : x);

/* ---------- fake coupon collection ---------- */
function makeStore(initial) {
  const doc = { ...initial };
  const mutex = new Mutex();
  return {
    snapshot: () => ({ ...doc }),               // models findOne() read
    // OLD (buggy) path: read-modify-write, last-writer-wins, NOT atomic.
    async oldRedeem() {
      const snap = { ...doc };                   // read
      const allowed = snap.usageLimit === 0 || snap.usedCount < snap.usageLimit;
      await tick();                              // force interleave (TOCTOU window)
      if (!allowed) return false;
      await tick();
      doc.usedCount = snap.usedCount + 1;        // write back stale+1 (lost update)
      return true;
    },
    // NEW (fixed) path: atomic conditional findOneAndUpdate.
    findOneAndUpdate(filter, update) {
      return mutex.run(async () => {
        await tick();                            // scheduling jitter inside the atomic apply
        if (!matches(doc, filter)) return null;
        if (update.$inc) for (const [k, n] of Object.entries(update.$inc)) doc[k] += n;
        return { ...doc };
      });
    },
    updateOne(filter, update) {                  // atomic, for rollback
      return mutex.run(async () => {
        if (!matches(doc, filter)) return { modifiedCount: 0 };
        if (update.$inc) for (const [k, n] of Object.entries(update.$inc)) doc[k] += n;
        return { modifiedCount: 1 };
      });
    },
    get usedCount() { return doc.usedCount; },
  };
}
const tick = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));

/* the EXACT claim filter from the patched controller */
const claimFilter = (id) => ({
  _id: id,
  $or: [{ usageLimit: 0 }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }],
});

let passed = 0;
const ok = (name) => { console.log("  PASS:", name); passed++; };

/* ---------- 0) the test is tied to the real patched file ---------- */
const ctrl = fs.readFileSync(new URL("../controllers/orderController.js", import.meta.url), "utf8");
assert.ok(ctrl.includes('$expr: { $lt: ["$usedCount", "$usageLimit"] }'),
  "patched controller must contain the atomic $expr/$lt claim filter");
assert.ok(ctrl.includes("$inc: { usedCount: 1 }"), "controller must atomically $inc usedCount");
assert.ok(ctrl.includes("$inc: { usedCount: -1 }"), "controller must roll back the slot on order failure");
assert.ok(!/appliedCoupon\.usedCount \+= 1/.test(ctrl), "the old non-atomic increment must be gone");
ok("patched controller contains atomic claim + rollback, old increment removed");

/* ---------- 1) OLD code BREACHES the cap under concurrency (reproduce bug) ---------- */
{
  const store = makeStore({ _id: "c1", code: "SAVE50", usageLimit: 100, usedCount: 99 }); // 1 slot left
  const results = await Promise.all(Array.from({ length: 50 }, () => store.oldRedeem()));
  const successes = results.filter(Boolean).length;
  assert.ok(successes > 1, `OLD: expected the race to over-redeem the single slot, got ${successes} successes`);
  console.log(`     (old code: ${successes} redemptions succeeded on a 1-slot coupon, final usedCount=${store.usedCount})`);
  ok("OLD read-modify-write over-redeems past usageLimit under concurrency (bug reproduced)");
}

/* ---------- 2) NEW atomic claim holds the cap under the SAME concurrency ---------- */
{
  const store = makeStore({ _id: "c2", code: "SAVE50", usageLimit: 100, usedCount: 99 }); // 1 slot left
  const results = await Promise.all(
    Array.from({ length: 50 }, () => store.findOneAndUpdate(claimFilter("c2"), { $inc: { usedCount: 1 } }))
  );
  const successes = results.filter((r) => r !== null).length;
  assert.equal(successes, 1, `NEW: exactly one claim must win, got ${successes}`);
  assert.equal(store.usedCount, 100, `usedCount must equal usageLimit, got ${store.usedCount}`);
  ok("NEW atomic claim: exactly 1 of 50 concurrent redemptions wins; cap never exceeded");
}

/* ---------- 3) heavy concurrency, many slots: exact count, no over/under ---------- */
{
  const store = makeStore({ _id: "c3", code: "BULK", usageLimit: 100, usedCount: 0 });
  const results = await Promise.all(
    Array.from({ length: 500 }, () => store.findOneAndUpdate(claimFilter("c3"), { $inc: { usedCount: 1 } }))
  );
  const successes = results.filter((r) => r !== null).length;
  assert.equal(successes, 100, `exactly 100 of 500 must succeed, got ${successes}`);
  assert.equal(store.usedCount, 100, `usedCount must be exactly 100, got ${store.usedCount}`);
  ok("NEW atomic claim: 500 concurrent -> exactly 100 redeemed, usedCount===100 (no over/undercount)");
}

/* ---------- 4) boundaries ---------- */
{
  // at limit-1: one succeeds, next fails
  const s = makeStore({ _id: "c4", code: "EDGE", usageLimit: 5, usedCount: 4 });
  assert.ok(await s.findOneAndUpdate(claimFilter("c4"), { $inc: { usedCount: 1 } }), "slot at limit-1 should claim");
  assert.equal(await s.findOneAndUpdate(claimFilter("c4"), { $inc: { usedCount: 1 } }), null, "claim at limit must reject");
  assert.equal(s.usedCount, 5, "usedCount caps at usageLimit");
  // usageLimit 0 = unlimited: all succeed
  const u = makeStore({ _id: "c5", code: "UNLIM", usageLimit: 0, usedCount: 0 });
  const r = await Promise.all(Array.from({ length: 1000 }, () => u.findOneAndUpdate(claimFilter("c5"), { $inc: { usedCount: 1 } })));
  assert.equal(r.filter((x) => x !== null).length, 1000, "unlimited coupon never rejects");
  assert.equal(u.usedCount, 1000, "unlimited usedCount counts all");
  ok("boundaries: limit-1 allows exactly one; usageLimit=0 is truly unlimited");
}

/* ---------- 5) rollback returns the slot on order failure (no burned use) ---------- */
{
  const s = makeStore({ _id: "c6", code: "ROLL", usageLimit: 10, usedCount: 0 });
  const claimed = await s.findOneAndUpdate(claimFilter("c6"), { $inc: { usedCount: 1 } }); // claim
  assert.ok(claimed && s.usedCount === 1, "claim took a slot");
  // simulate Order.create() throwing -> rollback path runs:
  await s.updateOne({ _id: "c6", usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
  assert.equal(s.usedCount, 0, "failed order must release the slot (usedCount back to 0)");
  // guard prevents underflow if rollback ever runs at 0:
  await s.updateOne({ _id: "c6", usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
  assert.equal(s.usedCount, 0, "rollback guard must never push usedCount negative");
  ok("rollback: a failed order releases its slot and never underflows");
}

console.log(`\nALL ${passed} CHECKS PASSED`);
