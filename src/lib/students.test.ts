import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { studentSchema } from "./students.js";

// A complete registration, minus the education / occupation details.
const base = {
  residingPincode: "600001", outsideTamilNadu: false, district: "Chennai", taluk: "Egmore",
  fullName: "Arun Kumar", fatherName: "Kumar S", motherName: "Lakshmi K", gender: "MALE", dob: "1995-06-15",
  bloodGroup: "O+ve", aadhaarNumber: "234123412346", phone: "9876543210", email: "arun@example.com", nationality: "Indian",
  address: "12, Anna Salai", city: "Chennai", state: "Tamil Nadu", pincode: "600002", annualIncome: 600000,
};
const education = { institutionType: "COLLEGE", institutionName: "Anna University", grade: "2nd Year" };
const occupation = { employmentType: "PRIVATE", organisationName: "Acme Pvt Ltd", occupation: "Software Engineer" };

const issues = (input: object) => {
  const r = studentSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => String(i.path[0]));
};

describe("studentSchema: students and working professionals", () => {
  it("defaults to a student, so existing callers keep working", () => {
    const r = studentSchema.parse({ ...base, ...education });
    assert.equal(r.participantType, "STUDENT");
  });

  it("requires education details from a student", () => {
    assert.deepEqual(issues({ ...base, participantType: "STUDENT" }).sort(), ["grade", "institutionName", "institutionType"]);
    assert.deepEqual(issues({ ...base, participantType: "STUDENT", ...occupation }).sort(), ["grade", "institutionName", "institutionType"]);
  });

  it("accepts a working professional with occupation details and no education", () => {
    const r = studentSchema.parse({ ...base, participantType: "PROFESSIONAL", ...occupation });
    assert.equal(r.participantType, "PROFESSIONAL");
    assert.equal(r.organisationName, "Acme Pvt Ltd");
    assert.equal(r.institutionType, "");
  });

  it("requires occupation details from a working professional", () => {
    assert.deepEqual(issues({ ...base, participantType: "PROFESSIONAL", ...education }).sort(), ["employmentType", "occupation", "organisationName"]);
  });

  it("rejects an unknown type or employment type", () => {
    assert.ok(issues({ ...base, ...education, participantType: "TEACHER" }).includes("participantType"));
    assert.ok(issues({ ...base, participantType: "PROFESSIONAL", ...occupation, employmentType: "FREELANCE" }).includes("employmentType"));
  });
});
