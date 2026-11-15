import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// The webhook secret is read when the env module loads, so it is set before importing payments.
process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret";
const { handleRazorpayWebhook } = await import("./payments.js");

const sign = (body: Buffer, secret = "test_webhook_secret") => crypto.createHmac("sha256", secret).update(body).digest("hex");
const event = (e: unknown) => Buffer.from(JSON.stringify(e));

test("webhook: a missing or wrong signature is refused", async () => {
  const body = event({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 100, status: "captured" } } } });
  assert.equal(await handleRazorpayWebhook(body, ""), 400);
  assert.equal(await handleRazorpayWebhook(body, sign(body, "another_secret")), 400);
  // A signature for different bytes (the body was changed on the way)
  assert.equal(await handleRazorpayWebhook(body, sign(event({ event: "payment.captured" }))), 400);
});

test("webhook: a signed body that isn't JSON is refused", async () => {
  const body = Buffer.from("not json");
  assert.equal(await handleRazorpayWebhook(body, sign(body)), 400);
});

test("webhook: events that aren't payments of an order are acknowledged and ignored", async () => {
  for (const e of [
    { event: "refund.created", payload: {} },
    { event: "payment.failed", payload: { payment: { entity: { id: "pay_2", order_id: "order_2", amount: 100, status: "failed" } } } },
    // A payment without an order (e.g. a payment link): not one of ours
    { event: "payment.captured", payload: { payment: { entity: { id: "pay_3", order_id: null, amount: 100, status: "captured" } } } },
  ]) {
    const body = event(e);
    assert.equal(await handleRazorpayWebhook(body, sign(body)), 200, e.event);
  }
});
