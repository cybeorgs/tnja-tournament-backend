import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emailProblem, normaliseEmail, suggestEmail } from "./emailAddress.js";
import { EMAIL_WINDOW_MS, nextSendAt } from "./emailOtp.js";

const check = (raw: string) => emailProblem(normaliseEmail(raw));

describe("email format", () => {
  it("accepts a valid address", () => assert.equal(check("hari@gmail.com"), null));
  it("trims spaces around the address", () => {
    assert.equal(normaliseEmail("  hari@gmail.com  "), "hari@gmail.com");
    assert.equal(check("hari@gmail.com "), null);
  });
  it("lower-cases it", () => assert.equal(normaliseEmail("Hari.K@Gmail.COM"), "hari.k@gmail.com"));
  it("requires an address", () => assert.match(check("")!, /enter your email/));
  it("rejects a missing @", () => assert.match(check("harigmail.com")!, /must contain @/));
  it("rejects spaces inside", () => assert.match(check("hari gmail.com")!, /can't contain spaces/));
  it("rejects a missing domain", () => {
    assert.match(check("hari@gmail")!, /missing the domain/);
    assert.match(check("hari@")!, /missing the domain/);
  });
  it("rejects other malformed addresses", () => {
    for (const bad of ["@gmail.com", "hari@@gmail.com", "hari..k@gmail.com", ".hari@gmail.com", "hari@gmail..com", "hari@-gmail.com", "hari@gmail.c", "hari@gmail.123"]) {
      assert.notEqual(check(bad), null, bad);
    }
  });
  it("rejects excessive length", () => {
    assert.match(check(`${"a".repeat(65)}@gmail.com`)!, /too long/);
    assert.match(check(`hari@${"a".repeat(250)}.com`)!, /too long/);
  });
  it("accepts plus addressing, subdomains and Indian domains", () => {
    for (const ok of ["hari+tnja@gmail.com", "hari.k@student.annauniv.edu", "hari@yahoo.co.in", "h_k-1@rediffmail.com"]) assert.equal(check(ok), null, ok);
  });
});

describe("typo suggestions", () => {
  it("suggests gmail.com for gamil.com, never changing it on its own", () => {
    assert.equal(suggestEmail("hari@gamil.com"), "hari@gmail.com");
    assert.equal(suggestEmail("hari@gmial.com"), "hari@gmail.com");
    assert.equal(suggestEmail("hari@gmail.con"), "hari@gmail.com");
    assert.equal(suggestEmail("hari@yaho.com"), "hari@yahoo.com");
    assert.equal(suggestEmail("hari@hotmial.com"), "hari@hotmail.com");
  });
  it("leaves correct and unrelated domains alone", () => {
    for (const ok of ["hari@gmail.com", "hari@mail.com", "hari@yahoo.co.in", "hari@student.annauniv.edu", "hari@tnja.in"]) assert.equal(suggestEmail(ok), null, ok);
  });
});

describe("OTP resend timing", () => {
  const t0 = Date.UTC(2026, 10, 9, 10, 0, 0);
  const at = (s: number) => new Date(t0 + s * 1000);
  it("sends the first code straight away", () => assert.equal(nextSendAt([], t0), t0));
  it("waits 60 s after the first code", () => assert.equal(nextSendAt([at(0)]), t0 + 60_000));
  it("waits 120 s after the second", () => assert.equal(nextSendAt([at(0), at(60)]), t0 + 180_000));
  it("after 3 codes, waits until the first of them is 15 minutes old", () => {
    // 3rd code at 180 s: 300 s cooldown would allow 480 s, but the 15-minute window allows only at 900 s.
    assert.equal(nextSendAt([at(0), at(60), at(180)]), t0 + EMAIL_WINDOW_MS);
  });
});
