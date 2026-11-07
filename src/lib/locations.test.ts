import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../middleware/errors.js";
import { isValidPincode, lookupPincode } from "./locations.js";

// Stub the India Post API (api.postalpincode.in) so the tests don't depend on the network.
const realFetch = globalThis.fetch;
const office = (Name: string, District: string, Block: string, State: string) => ({ Name, District, Block, State });
const DIRECTORY: Record<string, ReturnType<typeof office>[]> = {
  "600001": [office("Chennai", "Chennai", "Chennai", "Tamil Nadu"), office("Mannady (Chennai)", "Chennai", "Tondiarpet Fort St George", "Tamil Nadu")],
  "110001": [office("Connaught Place", "Central Delhi", "New Delhi", "Delhi")],
  "641001": [office("Coimbatore", "Coimbatore", "Coimbatore South", "Tamil Nadu")],
  // 600112 (Choolai, Chennai) has no record in api.postalpincode.in: it answers "No records found".
};
function stubIndiaPost() {
  globalThis.fetch = (async (url: string | URL) => {
    const pin = String(url).split("/").pop()!;
    const offices = DIRECTORY[pin];
    const body = offices ? [{ Status: "Success", PostOffice: offices }] : [{ Message: "No records found", Status: "Error", PostOffice: null }];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

describe("isValidPincode", () => {
  for (const pin of ["600112", "600001", "110001", "641001"]) {
    it(`accepts ${pin}`, () => assert.equal(isValidPincode(pin), true));
  }
  for (const pin of ["12345", "1234567", "ABC123", "12@456", "012345", "", " 600112", "600 12", "６00112"]) {
    it(`rejects ${JSON.stringify(pin)}`, () => assert.equal(isValidPincode(pin), false));
  }
  it("rejects non-strings", () => {
    assert.equal(isValidPincode(600112), false);
    assert.equal(isValidPincode(null), false);
  });
});

describe("lookupPincode", () => {
  it("accepts 600112 even though the India Post directory has no record of it", async () => {
    stubIndiaPost();
    const m = await lookupPincode("600112");
    assert.equal(m.found, false);
    assert.equal(m.inTamilNadu, true);
    assert.equal(m.district, "");
  });

  it("places 600001 in Chennai", async () => {
    stubIndiaPost();
    const m = await lookupPincode("600001");
    assert.equal(m.found, true);
    assert.equal(m.inTamilNadu, true);
    assert.equal(m.district, "Chennai");
  });

  it("places 641001 in Coimbatore", async () => {
    stubIndiaPost();
    const m = await lookupPincode("641001");
    assert.equal(m.inTamilNadu, true);
    assert.equal(m.district, "Coimbatore");
  });

  it("puts 110001 outside Tamil Nadu", async () => {
    stubIndiaPost();
    const m = await lookupPincode("110001");
    assert.equal(m.inTamilNadu, false);
    assert.equal(m.state, "Delhi");
  });

  it("treats an unlisted pincode outside the Tamil Nadu circle as outside Tamil Nadu", async () => {
    stubIndiaPost();
    const m = await lookupPincode("560999");
    assert.equal(m.found, false);
    assert.equal(m.inTamilNadu, false);
  });

  for (const pin of ["12345", "1234567", "ABC123", "12@456", "012345"]) {
    it(`rejects ${pin} with a 400 before calling India Post`, async () => {
      let called = false;
      globalThis.fetch = (async () => { called = true; throw new Error("should not be called"); }) as typeof fetch;
      await assert.rejects(lookupPincode(pin), (err: unknown) => err instanceof HttpError && err.status === 400 && /exactly 6 digits/.test(err.message));
      assert.equal(called, false);
    });
  }
});
