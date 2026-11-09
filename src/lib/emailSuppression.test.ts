import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { brevoSuppression } from "./emailSuppression.js";

// Payloads as documented in Brevo's "Transactional webhooks" reference (trimmed to the fields that matter).
const base = { email: "Example@Domain.com", id: 1, date: "2020-10-09 00:00:00", ts: 1604933619, "message-id": "201798300811.5787683@relay.domain.com", ts_event: 1604933654, subject: "My first Transactional", tags: ["transac_messages"] };

describe("Brevo webhook → suppression list", () => {
  it("suppresses hard bounces, blocked, invalid email, spam and unsubscribes", () => {
    const expected: Record<string, string> = { hard_bounce: "HARD_BOUNCE", blocked: "BLOCKED", invalid_email: "INVALID", spam: "SPAM", unsubscribed: "UNSUBSCRIBED" };
    for (const [event, reason] of Object.entries(expected)) {
      const hit = brevoSuppression({ ...base, event, reason: "server is down" });
      assert.equal(hit?.reason, reason, event);
      assert.equal(hit?.email, "example@domain.com", "address is normalised");
      assert.match(hit!.detail, /message-id: 201798300811\.5787683@relay\.domain\.com/);
    }
  });

  it("ignores temporary failures, Brevo-side errors and engagement events", () => {
    for (const event of ["soft_bounce", "deferred", "error", "request", "delivered", "opened", "unique_opened", "click", "proxy_open", "unique_proxy_open"]) {
      assert.equal(brevoSuppression({ ...base, event }), null, event);
    }
  });

  it("ignores payloads without a usable address", () => {
    assert.equal(brevoSuppression({ ...base, event: "hard_bounce", email: "" }), null);
    assert.equal(brevoSuppression({ ...base, event: "hard_bounce", email: "not-an-email" }), null);
    assert.equal(brevoSuppression(null), null);
    assert.equal(brevoSuppression("hard_bounce"), null);
  });
});
