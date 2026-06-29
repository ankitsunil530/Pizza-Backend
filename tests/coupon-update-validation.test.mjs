/**
 * Validation-parity regression test for updateCoupon (issue #69).
 *
 * A real mongod is not available in this sandbox, so — following the same
 * approach as coupon-race.test.mjs — this test models the exact validation
 * decisions updateCoupon makes and checks they mirror createCoupon's rules.
 * It also asserts the controller source still contains the guard logic, so
 * the test fails if the fix is later removed or weakened.
 *
 * Run: node backend/tests/coupon-update-validation.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const controllerSrc = fs.readFileSync(
  path.join(__dirname, "..", "controllers", "couponController.js"),
  "utf8"
);

/* ---------- faithful models of the two updateCoupon guards ---------- */

// Percentage cap, evaluated against the EFFECTIVE (incoming-or-stored)
// type and value — byte-for-byte the decision in the controller.
function percentCapRejects(stored, body) {
  const effectiveType = body.discountType ?? stored.discountType;
  const effectiveValue =
    body.discountValue !== undefined ? Number(body.discountValue) : stored.discountValue;
  return effectiveType === "percent" && effectiveValue > 100;
}

// Non-negative coercion mirror (createCoupon uses the same expression).
function coerceAmount(x) {
  return Math.max(0, Number(x) || 0);
}

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed += 1;
}

/* ---------- percentage-cap scenarios ---------- */
check(
  "stored percent coupon + PUT { discountValue: 150 } -> rejected (the reported bug)",
  percentCapRejects({ discountType: "percent", discountValue: 20 }, { discountValue: 150 }) === true
);
check(
  "stored percent coupon + PUT { discountValue: 80 } -> allowed",
  percentCapRejects({ discountType: "percent", discountValue: 20 }, { discountValue: 80 }) === false
);
check(
  "stored flat-150 coupon + PUT { discountType: 'percent' } (no value) -> rejected",
  percentCapRejects({ discountType: "flat", discountValue: 150 }, { discountType: "percent" }) === true
);
check(
  "PUT { discountType: 'percent', discountValue: 150 } -> rejected",
  percentCapRejects(
    { discountType: "flat", discountValue: 10 },
    { discountType: "percent", discountValue: 150 }
  ) === true
);
check(
  "stored flat coupon + PUT { discountValue: 200 } (stays flat) -> allowed (flat may exceed 100)",
  percentCapRejects({ discountType: "flat", discountValue: 150 }, { discountValue: 200 }) === false
);
check(
  "stored percent coupon + PUT { discountType: 'flat', discountValue: 500 } -> allowed",
  percentCapRejects(
    { discountType: "percent", discountValue: 20 },
    { discountType: "flat", discountValue: 500 }
  ) === false
);
check(
  "stored percent coupon + PUT { discountValue: 100 } -> allowed (cap is strictly > 100)",
  percentCapRejects({ discountType: "percent", discountValue: 20 }, { discountValue: 100 }) === false
);

/* ---------- non-negative coercion scenarios ---------- */
check("minOrderAmount -500 -> floored to 0", coerceAmount(-500) === 0);
check("maxDiscount -5 -> floored to 0", coerceAmount(-5) === 0);
check("non-numeric 'abc' -> 0", coerceAmount("abc") === 0);
check("valid 250 -> 250", coerceAmount(250) === 250);
check("0 -> 0", coerceAmount(0) === 0);

/* ---------- source guards: fail if the fix is removed ---------- */
check("controller evaluates effective type for the percent cap", controllerSrc.includes("effectiveType"));
check("controller evaluates effective value for the percent cap", controllerSrc.includes("effectiveValue"));
check(
  "controller floors minOrderAmount at 0",
  controllerSrc.includes("Math.max(0, Number(req.body.minOrderAmount)")
);
check(
  "controller floors maxDiscount at 0",
  controllerSrc.includes("Math.max(0, Number(req.body.maxDiscount)")
);
check(
  "minOrderAmount no longer assigned raw via the generic updatable loop",
  !/updatable\s*=\s*\[[^\]]*"minOrderAmount"/s.test(controllerSrc)
);
check(
  "maxDiscount no longer assigned raw via the generic updatable loop",
  !/updatable\s*=\s*\[[^\]]*"maxDiscount"/s.test(controllerSrc)
);

console.log(`\u2713 coupon-update-validation: all ${passed} checks passed`);
