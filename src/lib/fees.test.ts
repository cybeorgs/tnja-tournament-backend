import { test } from "node:test";
import assert from "node:assert/strict";
import { feeFor, repriceEntries } from "./fees.js";

type Row = { id: string; studentId: string; fee: number; paymentStatus: string };

/** Just enough of the Prisma client for repriceEntries, over an in-memory list (already in entry order). */
function fakeDb(fees: { entryFee: number; additionalEntryFee: number }, rows: Row[]) {
  return {
    tournament: { findUnique: async () => fees },
    registration: {
      findMany: async ({ where }: { where: { studentId?: string } }) => rows.filter((r) => !where.studentId || r.studentId === where.studentId).map((r) => ({ ...r })),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(rows.find((r) => r.id === where.id)!, data),
    },
  } as never;
}

test("first category pays the full fee, the rest the additional fee", () => {
  assert.equal(feeFor({ entryFee: 500, additionalEntryFee: 200 }, true), 500);
  assert.equal(feeFor({ entryFee: 500, additionalEntryFee: 200 }, false), 200);
  // Never more than the full fee, even if set that way
  assert.equal(feeFor({ entryFee: 300, additionalEntryFee: 400 }, false), 300);
});

test("new entries: one full fee per player, the others discounted", async () => {
  const rows: Row[] = [
    { id: "a1", studentId: "A", fee: 500, paymentStatus: "PENDING" },
    { id: "a2", studentId: "A", fee: 500, paymentStatus: "PENDING" },
    { id: "a3", studentId: "A", fee: 500, paymentStatus: "PENDING" },
    { id: "b1", studentId: "B", fee: 500, paymentStatus: "PENDING" },
  ];
  await repriceEntries(fakeDb({ entryFee: 500, additionalEntryFee: 200 }, rows), "t");
  assert.deepEqual(rows.map((r) => r.fee), [500, 200, 200, 500]);
});

test("adding a category after paying the first one charges only the additional fee", async () => {
  const rows: Row[] = [
    { id: "a1", studentId: "A", fee: 500, paymentStatus: "PAID" },
    { id: "a2", studentId: "A", fee: 500, paymentStatus: "PENDING" },
  ];
  await repriceEntries(fakeDb({ entryFee: 500, additionalEntryFee: 200 }, rows), "t", "A");
  assert.deepEqual(rows.map((r) => [r.fee, r.paymentStatus]), [[500, "PAID"], [200, "PENDING"]]);
});

test("removing the unpaid first category moves the full fee to the next unpaid one", async () => {
  const rows: Row[] = [{ id: "a2", studentId: "A", fee: 200, paymentStatus: "PENDING" }];
  await repriceEntries(fakeDb({ entryFee: 500, additionalEntryFee: 200 }, rows), "t", "A");
  assert.equal(rows[0]!.fee, 500);
});

test("free additional categories are waived", async () => {
  const rows: Row[] = [
    { id: "a1", studentId: "A", fee: 500, paymentStatus: "PENDING" },
    { id: "a2", studentId: "A", fee: 500, paymentStatus: "PENDING" },
  ];
  await repriceEntries(fakeDb({ entryFee: 500, additionalEntryFee: 0 }, rows), "t", "A");
  assert.deepEqual(rows.map((r) => [r.fee, r.paymentStatus]), [[500, "PENDING"], [0, "WAIVED"]]);
});
