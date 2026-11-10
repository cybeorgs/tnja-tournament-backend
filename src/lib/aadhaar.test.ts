import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchAadhaar } from "./aadhaar.js";

const details = { maskedAadhaar: "xxxxxxxx2346", name: "Arun Kumar", gender: "M", dateOfBirth: "15-06-1995", pincode: "600001" };

describe("matchAadhaar", () => {
  it("accepts matching last 4 digits, pincode and date of birth", () => {
    assert.deepEqual(matchAadhaar(details, "234123412346", "600001", "1995-06-15"), { ok: true });
  });

  it("rejects another Aadhaar number", () => {
    const r = matchAadhaar(details, "234123419999", "600001", "1995-06-15");
    assert.equal(r.ok, false);
  });

  it("names the Aadhaar pincode so the student can correct it, then accepts the corrected value", () => {
    const wrong = matchAadhaar(details, "234123412346", "600002", "1995-06-15");
    assert.equal(wrong.ok, false);
    assert.equal(!wrong.ok && wrong.aadhaarPincode, "600001");
    // The same fetched Aadhaar is matched again, without another DigiLocker session.
    assert.deepEqual(matchAadhaar(details, "234123412346", "600001", "1995-06-15"), { ok: true });
  });

  it("rejects a different date of birth", () => {
    const r = matchAadhaar(details, "234123412346", "600001", "1995-06-16");
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /15\/06\/1995/);
  });

  it("matches only the year when the Aadhaar records just the year of birth", () => {
    const yearOnly = { ...details, dateOfBirth: "1995" };
    assert.deepEqual(matchAadhaar(yearOnly, "234123412346", "600001", "1995-01-01"), { ok: true });
    assert.equal(matchAadhaar(yearOnly, "234123412346", "600001", "1996-01-01").ok, false);
  });

  it("rejects an Aadhaar without pincode or date of birth", () => {
    assert.equal(matchAadhaar({ ...details, pincode: null }, "234123412346", "600001", "1995-06-15").ok, false);
    assert.equal(matchAadhaar({ ...details, dateOfBirth: null }, "234123412346", "600001", "1995-06-15").ok, false);
  });
});
