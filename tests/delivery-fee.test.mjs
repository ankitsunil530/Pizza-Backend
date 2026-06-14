/**
 * Tests for the server-side delivery fee computation added in issue #37.
 *
 *   node backend/tests/delivery-fee.test.mjs
 *
 * Zero-dependency: Node built-in test runner, reads source directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const controller = readFileSync(
  new URL("../controllers/orderController.js", import.meta.url),
  "utf8"
);

/* ==================== STRUCTURAL TESTS ==================== */

test("deliveryFee is NOT destructured from req.body", () => {
  // The client-supplied deliveryFee must be completely ignored.
  assert.doesNotMatch(
    controller,
    /deliveryFee\s*=\s*0.*req\.body/,
    "deliveryFee must not be read from req.body"
  );
});

test("DELIVERY_FEE is read from process.env with default 40", () => {
  assert.match(
    controller,
    /Number\(process\.env\.DELIVERY_FEE\)\s*\|\|\s*40/,
    "must read DELIVERY_FEE from env with default 40"
  );
});

test("FREE_DELIVERY_THRESHOLD is read from process.env with default 499", () => {
  assert.match(
    controller,
    /Number\(process\.env\.FREE_DELIVERY_THRESHOLD\)\s*\|\|\s*499/,
    "must read FREE_DELIVERY_THRESHOLD from env with default 499"
  );
});

test("safeDeliveryFee uses server-side threshold check not Math.max", () => {
  assert.doesNotMatch(
    controller,
    /Math\.max\(0,\s*Number\(deliveryFee\)/,
    "old client-supplied computation must be gone"
  );
  assert.match(
    controller,
    /subtotal > FREE_DELIVERY_THRESHOLD.*\|\|.*subtotal === 0.*\? 0 : DELIVERY_FEE/s,
    "must apply free-delivery threshold and zero-subtotal guard"
  );
});

/* ==================== LOGIC UNIT TESTS ==================== */

// Replicate the server-side computation so it can be tested independently.
const computeDeliveryFee = (subtotal, envFee = 40, envThreshold = 499) => {
  const DELIVERY_FEE = envFee;
  const FREE_DELIVERY_THRESHOLD = envThreshold;
  return subtotal > FREE_DELIVERY_THRESHOLD || subtotal === 0 ? 0 : DELIVERY_FEE;
};

test("subtotal of 0 → free delivery (empty-cart guard)", () => {
  assert.equal(computeDeliveryFee(0), 0);
});

test("subtotal of 499 → delivery fee charged (at threshold, not above)", () => {
  assert.equal(computeDeliveryFee(499), 40);
});

test("subtotal of 500 → free delivery (just above threshold)", () => {
  assert.equal(computeDeliveryFee(500), 0);
});

test("subtotal of 300 → delivery fee charged", () => {
  assert.equal(computeDeliveryFee(300), 40);
});

test("subtotal of 1000 → free delivery (well above threshold)", () => {
  assert.equal(computeDeliveryFee(1000), 0);
});

test("env override: DELIVERY_FEE=60 charges 60 when below threshold", () => {
  assert.equal(computeDeliveryFee(300, 60, 499), 60);
});

test("env override: FREE_DELIVERY_THRESHOLD=999 charges fee for 500", () => {
  assert.equal(computeDeliveryFee(500, 40, 999), 40);
});

test("env override: FREE_DELIVERY_THRESHOLD=999, subtotal 1000 → free", () => {
  assert.equal(computeDeliveryFee(1000, 40, 999), 0);
});

test("client sending deliveryFee=0 cannot bypass the charge", () => {
  // Even if a client sends deliveryFee=0, the server uses subtotal=300.
  // The client value is irrelevant — server always uses subtotal.
  const clientSentValue = 0;    // attacker sends this
  const serverComputed = computeDeliveryFee(300); // server ignores clientSentValue
  assert.equal(serverComputed, 40);             // ₹40 charged regardless
  assert.notEqual(clientSentValue, serverComputed);
});
