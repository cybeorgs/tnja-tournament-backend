// ─── Online entry-fee payments (Razorpay) ────────────────────────────────────
// A student pays all their unpaid entries in a tournament in one go: right after registering (the
// registration reply carries a short-lived pay token), or later from their student login. Each event paid
// for gets its Tournament Entry Pass by email.
//
// A payment is confirmed by whichever of these reaches us first (each is safe to repeat):
//   1. the browser, right after Checkout succeeds (POST …/verify, signature checked);
//   2. Razorpay's webhook (payment.captured / payment.authorized / order.paid), which arrives even when
//      the player's tab was closed, the phone switched to a UPI app, or their connection dropped;
//   3. the reconciler, which asks Razorpay every few minutes about orders not yet paid;
//   4. opening a new order (earlier orders of the same player are checked first, so nobody pays twice);
//   5. an admin's "Sync with Razorpay", which also recovers payments made before order records existed.
//
// Safeguards:
//   • Every order is kept in PaymentOrder with the entries it covers and what each was charged. A payment
//     is matched through that record, so an order replaced by a newer one still counts when its payment
//     completes late (the cause of "paid but still showing unpaid").
//   • An entry is marked paid only when Razorpay itself reports the payment captured, for that order and for
//     exactly the order's amount. One Razorpay payment can pay one order only.
//   • Anything that doesn't add up (an entry removed or already paid meanwhile, an amount that doesn't match)
//     is marked REVIEW for an admin instead of being guessed at. Nothing is ever refunded automatically.
//   • Payments are accepted until the tournament starts (registration itself closes earlier).
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { PaymentOrder } from "@prisma/client";
import prisma from "../db.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errors.js";
import { sendEntryPassesLater } from "./entryPass.js";
import { repriceEntries } from "./fees.js";
import { recordPaymentAudit, type Actor } from "./audit.js";

export const onlinePaymentEnabled = () => !!env.razorpayKeyId && !!env.razorpayKeySecret;

// ── Razorpay REST API (no SDK needed) ──

type GatewayPayment = { id: string; order_id: string | null; amount: number; status: string; created_at?: number };
type GatewayOrder = { id: string; amount: number; currency: string; receipt?: string | null };

async function razorpay<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!onlinePaymentEnabled()) throw new HttpError(503, "Online payment isn't available right now. Please contact the organiser.");
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString("base64")}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => null)) as { error?: { description?: string } } | null;
  if (!res.ok) {
    console.error(`[payments] Razorpay ${method} ${path} → ${res.status}:`, json?.error?.description ?? json);
    throw new HttpError(502, "The payment gateway didn't respond as expected. Please try again in a minute.");
  }
  return json as T;
}

// ── Pay token: lets the registration screen pay without logging in ──

const payKey = () => crypto.createHmac("sha256", env.jwtSecret).update("entry-payment").digest("hex");

/** Given with the registration (or a returning player's entry) reply; valid for 12 hours. */
export const createPayToken = (tournamentId: string, studentId: string) =>
  jwt.sign({ purpose: "pay", tournamentId, studentId }, payKey(), { expiresIn: "12h" });

export function readPayToken(token: unknown): { tournamentId: string; studentId: string } {
  try {
    const p = jwt.verify(String(token ?? ""), payKey()) as jwt.JwtPayload;
    if (p.purpose === "pay" && typeof p.tournamentId === "string" && typeof p.studentId === "string") return { tournamentId: p.tournamentId, studentId: p.studentId };
  } catch {
    /* fall through */
  }
  throw new HttpError(401, "This payment link has expired. Log in to your student account to pay.");
}

// ── Order records ──

type Line = { registrationId: string; fee: number };
const linesOf = (order: PaymentOrder) => order.lines as unknown as Line[];
const sum = (lines: Line[]) => lines.reduce((n, l) => n + l.fee, 0);

/** How a payment reached us, for the order's note. */
export type PaymentSource = "BROWSER" | "WEBHOOK" | "RECONCILE" | "NEW_ORDER" | "SYNC";
const SOURCE_NOTE: Record<PaymentSource, string> = {
  BROWSER: "Confirmed by the player's browser",
  WEBHOOK: "Confirmed by Razorpay webhook",
  RECONCILE: "Confirmed by the automatic check",
  NEW_ORDER: "Confirmed when the player opened a new payment",
  SYNC: "Confirmed by Sync with Razorpay",
};

/**
 * The order's record. One opened before records were kept is rebuilt from the entries that still point at
 * it, or, if a newer order replaced it, from its Razorpay receipt (reg_<first entry's id>): then it covers
 * that player's unpaid entries in the tournament, and goes to REVIEW unless their fees add up to exactly
 * what Razorpay charged. Null when the order isn't one of ours.
 */
async function orderRecord(orderId: string): Promise<PaymentOrder | null> {
  const found = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  if (found) return found;

  const gateway = await razorpay<GatewayOrder>("GET", `/orders/${encodeURIComponent(orderId)}`);
  let entries = await prisma.registration.findMany({ where: { razorpayOrderId: orderId }, orderBy: { createdAt: "asc" } });
  let lines: Line[];
  let how: string;
  if (entries.length) {
    lines = entries.map((r) => ({ registrationId: r.id, fee: r.orderFee ?? r.fee }));
    how = "Recovered order (opened before order records were kept)";
  } else {
    const prefix = /^reg_([0-9a-f]{8,32})$/.exec(gateway.receipt ?? "")?.[1];
    if (!prefix) return null;
    const firsts = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Registration" WHERE replace(id, '-', '') LIKE ${`${prefix}%`} LIMIT 2`;
    const first = firsts.length === 1 ? await prisma.registration.findUnique({ where: { id: firsts[0]!.id } }) : null;
    if (!first) return null;
    entries = await prisma.registration.findMany({
      where: { tournamentId: first.tournamentId, studentId: first.studentId, paymentStatus: "PENDING", fee: { gt: 0 } },
      orderBy: { createdAt: "asc" },
    });
    lines = entries.map((r) => ({ registrationId: r.id, fee: r.orderFee ?? r.fee }));
    entries = entries.length ? entries : [first];
    how = "Recovered order (a newer order had replaced it)";
  }
  const amount = Math.round(gateway.amount / 100);
  const adds = lines.length > 0 && sum(lines) === amount;
  return prisma.paymentOrder.upsert({
    where: { id: orderId },
    create: {
      id: orderId, tournamentId: entries[0]!.tournamentId, studentId: entries[0]!.studentId,
      lines, amount, status: adds ? "CREATED" : "REVIEW",
      note: adds ? how : `${how}: the player's unpaid entries (₹${sum(lines)}) don't match the ₹${amount} order — check which entries it was for`,
    },
    update: {},
  });
}

/** The payment captured (accounts without auto-capture: capture it now, or Razorpay refunds it in a few days). */
async function ensureCaptured(payment: GatewayPayment): Promise<GatewayPayment> {
  if (payment.status === "captured") return payment;
  if (payment.status !== "authorized") throw new HttpError(400, "The payment hasn't been completed.");
  try {
    return await razorpay<GatewayPayment>("POST", `/payments/${encodeURIComponent(payment.id)}/capture`, { amount: payment.amount, currency: "INR" });
  } catch (err) {
    // Captured meanwhile (auto-capture, or the webhook and the browser at the same moment)?
    const again = await razorpay<GatewayPayment>("GET", `/payments/${encodeURIComponent(payment.id)}`);
    if (again.status === "captured") return again;
    throw err;
  }
}

export type RecordResult = "RECORDED" | "ALREADY" | "REVIEW";

/**
 * Record a payment of one of our orders: mark the order's entries paid, at what each was charged.
 * Safe to call any number of times, from anywhere, at the same moment: it is applied once.
 * `expect` (from the browser): the order must belong to this tournament and student.
 */
export async function recordPayment(orderId: string, payment: GatewayPayment, source: PaymentSource, expect?: { tournamentId: string; studentId: string }): Promise<RecordResult> {
  if (payment.order_id !== orderId) throw new HttpError(400, "This payment is for a different order.");
  const order = await orderRecord(orderId);
  if (!order) throw new HttpError(400, "This payment doesn't belong to these entries.");
  if (expect && (order.tournamentId !== expect.tournamentId || order.studentId !== expect.studentId)) {
    throw new HttpError(400, "This payment doesn't belong to these entries.");
  }
  if (order.paymentId === payment.id) return order.status === "REVIEW" ? "REVIEW" : "ALREADY";

  const captured = await ensureCaptured(payment);
  const paidAt = captured.created_at ? new Date(captured.created_at * 1000) : new Date();
  if (Number(captured.amount) !== order.amount * 100) {
    console.error(`[payments] Amount mismatch on order ${orderId}: paid ${captured.amount} paise, order ₹${order.amount} (payment ${captured.id})`);
    await prisma.paymentOrder.updateMany({
      where: { id: orderId, paymentId: null },
      data: { status: "REVIEW", paymentId: captured.id, paidAt, note: `Paid ₹${Number(captured.amount) / 100} but the order was ₹${order.amount} — check and settle by hand` },
    });
    throw new HttpError(400, "The amount paid doesn't match the entry fee. Please contact the organiser with your transaction ID.");
  }

  const lines = linesOf(order);
  const [student, tournament] = await Promise.all([
    prisma.student.findUnique({ where: { id: order.studentId }, select: { id: true, studentNo: true, fullName: true, email: true } }),
    prisma.tournament.findUnique({ where: { id: order.tournamentId }, select: { title: true } }),
  ]);

  const result = await prisma.$transaction(async (tx): Promise<RecordResult> => {
    // One at a time per order: the browser, the webhook and the reconciler may all arrive together.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`pay:${orderId}`}))`;
    const fresh = await tx.paymentOrder.findUnique({ where: { id: orderId } });
    if (!fresh) throw new HttpError(400, "This payment doesn't belong to these entries.");
    if (fresh.paymentId === captured.id) return fresh.status === "REVIEW" ? "REVIEW" : "ALREADY";
    if (fresh.paymentId) {
      // A second successful payment for the same order: never applied twice.
      console.error(`[payments] Order ${orderId} already paid by ${fresh.paymentId}; payment ${captured.id} is a second payment — refund it`);
      await tx.paymentOrder.update({ where: { id: orderId }, data: { status: "REVIEW", note: `${fresh.note}; second payment ${captured.id} for the same order — refund it` } });
      return "REVIEW";
    }
    if (fresh.status === "REVIEW") {
      // A recovered order whose entries don't add up: record the payment, leave the entries to an admin.
      await tx.paymentOrder.update({ where: { id: orderId }, data: { paymentId: captured.id, paidAt } });
      return "REVIEW";
    }

    const entries = await tx.registration.findMany({ where: { id: { in: lines.map((l) => l.registrationId) } } });
    const problems: string[] = [];
    for (const line of lines) {
      const r = entries.find((e) => e.id === line.registrationId);
      if (!r) { problems.push(`an entry (₹${line.fee}) was removed before the payment arrived — refund ₹${line.fee}`); continue; }
      const after = { paymentStatus: "PAID", paymentMode: "RAZORPAY", amountPaid: line.fee, fee: line.fee, paidAt };
      const { count } = await tx.registration.updateMany({ where: { id: r.id, paymentStatus: "PENDING" }, data: { ...after, razorpayOrderId: orderId, razorpayPaymentId: captured.id } });
      if (!count) {
        // Already paid by this very payment (recorded before order records were kept): nothing to do.
        if (r.paymentStatus === "PAID" && r.razorpayPaymentId === captured.id) continue;
        // An admin recorded this same online payment by hand (their remark quotes its ID): not a second payment.
        if (r.paymentStatus === "PAID" && r.paymentMode !== "RAZORPAY" && (await adminRecordedThisPayment(tx, r, captured.id))) {
          await adoptHandRecorded(tx, [r], orderId, captured.id);
          continue;
        }
        problems.push(`${r.ageGroup} ${r.weightCategory} was already ${r.paymentStatus === "PAID" ? `paid (${r.paymentMode ?? "?"})` : r.paymentStatus.toLowerCase()} — check whether the player paid twice (refund ₹${line.fee} only if so)`);
        continue;
      }
      if (student) {
        await recordPaymentAudit(tx, student, { ...r, tournament: tournament?.title ?? "" }, r, after, { type: "STUDENT", name: student.email }, `Paid online (Razorpay ${captured.id}) — ${SOURCE_NOTE[source].toLowerCase()}`);
      }
    }
    await tx.paymentOrder.update({
      where: { id: orderId },
      data: { status: problems.length ? "REVIEW" : "PAID", paymentId: captured.id, paidAt, note: [SOURCE_NOTE[source], ...problems].join("; ") },
    });
    return problems.length ? "REVIEW" : "RECORDED";
  });

  if (result !== "ALREADY") {
    console.log(`[payments] ${captured.id} for order ${orderId}: ${result} (${source})`);
    sendEntryPassesLater(order.tournamentId, order.studentId, { trigger: "PAYMENT", actor: `Razorpay ${captured.id}` });
  }
  return result;
}

/** Ask Razorpay whether an order was paid, and record it if so. Never throws. */
async function checkOrder(orderId: string, source: PaymentSource): Promise<RecordResult | "UNPAID" | "ERROR"> {
  try {
    const { items } = await razorpay<{ items: GatewayPayment[] }>("GET", `/orders/${encodeURIComponent(orderId)}/payments`);
    const paid = items.find((p) => p.status === "captured") ?? items.find((p) => p.status === "authorized");
    await prisma.paymentOrder.updateMany({ where: { id: orderId }, data: { lastCheckedAt: new Date() } });
    return paid ? await recordPayment(orderId, paid, source) : "UNPAID";
  } catch (err) {
    console.error(`[payments] Could not check order ${orderId}:`, err instanceof Error ? err.message : err);
    return "ERROR";
  }
}

/** Before a new order: record any earlier order of this player's entries that was paid (so nobody pays twice). */
async function settleEarlierOrders(tournamentId: string, studentId: string) {
  const [orders, legacy] = await Promise.all([
    prisma.paymentOrder.findMany({ where: { tournamentId, studentId, status: "CREATED" }, select: { id: true } }),
    // Orders opened before order records were kept
    prisma.registration.findMany({ where: { tournamentId, studentId, paymentStatus: "PENDING", razorpayOrderId: { not: null } }, select: { razorpayOrderId: true }, distinct: ["razorpayOrderId"] }),
  ]);
  const ids = new Set([...orders.map((o) => o.id), ...legacy.map((r) => r.razorpayOrderId!)]);
  for (const id of ids) await checkOrder(id, "NEW_ORDER");
}

// ── The two steps the browser calls ──

export type CheckoutOrder = {
  keyId: string; orderId: string; amount: number; currency: string; entries: number;
  tournament: string; name: string; email: string; phone: string;
};

/**
 * Step 1: one Razorpay order for all of the student's unpaid entries in the tournament.
 * Null when nothing is left to pay (e.g. an earlier payment turned out to have gone through).
 */
export async function createOrder(tournamentId: string, studentId: string): Promise<CheckoutOrder | null> {
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!tournament) throw new HttpError(404, "Tournament not found.");
  if (tournament.status === "COMPLETED" || new Date() >= tournament.startDate) {
    throw new HttpError(409, "This tournament has started, so entry fees can no longer be paid online. Please contact the organiser.");
  }
  await settleEarlierOrders(tournamentId, studentId);
  // The fees that apply now (first category full, the rest the additional fee).
  await repriceEntries(prisma, tournamentId, studentId);

  const toPay = await prisma.registration.findMany({ where: { tournamentId, studentId, paymentStatus: "PENDING", fee: { gt: 0 } }, include: { student: true }, orderBy: { createdAt: "asc" } });
  const first = toPay[0];
  if (!first) return null;
  const lines: Line[] = toPay.map((r) => ({ registrationId: r.id, fee: r.fee }));
  const total = sum(lines);

  const order = await razorpay<GatewayOrder>("POST", "/orders", {
    amount: total * 100,
    currency: "INR",
    receipt: `reg_${first.id.replace(/-/g, "").slice(0, 30)}`,
    notes: {
      tournament: tournament.title.slice(0, 200), student: `${first.student.studentNo ?? ""} ${first.student.fullName}`.trim().slice(0, 200), entries: String(toPay.length),
      // For tracing an order back from the Razorpay dashboard
      tournamentId, studentId,
    },
  });
  // The order is recorded before the player can pay it, together with the entries it covers.
  await prisma.$transaction([
    prisma.paymentOrder.create({ data: { id: order.id, tournamentId, studentId, lines, amount: total } }),
    ...toPay.map((r) => prisma.registration.update({ where: { id: r.id }, data: { razorpayOrderId: order.id, orderFee: r.fee } })),
  ]);
  return {
    keyId: env.razorpayKeyId, orderId: order.id, amount: order.amount, currency: order.currency, entries: toPay.length,
    tournament: tournament.title, name: first.student.fullName, email: first.student.email, phone: first.student.phone,
  };
}

export const verifySchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

const safeEqual = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Step 2: what Checkout hands back. Razorpay's signature first, then the payment as Razorpay reports it. */
export async function confirmPayment(tournamentId: string, studentId: string, body: z.infer<typeof verifySchema>) {
  const expected = crypto.createHmac("sha256", env.razorpayKeySecret).update(`${body.razorpay_order_id}|${body.razorpay_payment_id}`).digest("hex");
  if (!safeEqual(expected, body.razorpay_signature)) throw new HttpError(400, "The payment couldn't be verified.");

  const payment = await razorpay<GatewayPayment>("GET", `/payments/${encodeURIComponent(body.razorpay_payment_id)}`).catch(() => {
    throw new HttpError(502, "We couldn't confirm the payment with the gateway yet. If money was taken, it will show as paid within a few minutes — please don't pay again.");
  });
  await recordPayment(body.razorpay_order_id, payment, "BROWSER", { tournamentId, studentId });
  return prisma.registration.findMany({ where: { tournamentId, studentId }, orderBy: { createdAt: "asc" } });
}

// ── Webhook ──

/**
 * Razorpay webhook (payment.captured, payment.authorized, order.paid). `rawBody` must be the exact bytes
 * received: the signature is over them. Returns the HTTP status to answer with: 200 once handled (or when
 * the event isn't for us), 400 for a bad signature, 500 when something on our side failed — Razorpay then
 * retries the event later.
 */
export async function handleRazorpayWebhook(rawBody: Buffer, signature: string): Promise<number> {
  if (!env.razorpayWebhookSecret) {
    console.error("[payments] Webhook received but RAZORPAY_WEBHOOK_SECRET is not set — set it to the secret entered in the Razorpay dashboard");
    return 503;
  }
  const expected = crypto.createHmac("sha256", env.razorpayWebhookSecret).update(rawBody).digest("hex");
  if (!signature || !safeEqual(expected, signature)) {
    console.warn("[payments] Webhook with an invalid signature ignored");
    return 400;
  }
  let event: { event?: string; payload?: { payment?: { entity?: GatewayPayment } } };
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return 400;
  }
  const payment = event.payload?.payment?.entity;
  if (!["payment.captured", "payment.authorized", "order.paid"].includes(event.event ?? "") || !payment?.order_id) return 200;
  try {
    await recordPayment(payment.order_id, payment, "WEBHOOK");
    return 200;
  } catch (err) {
    // Not ours / doesn't add up (logged and marked for review): retrying won't help. Anything else: retry.
    if (err instanceof HttpError && err.status < 500) {
      console.warn(`[payments] Webhook ${event.event} for ${payment.id} (order ${payment.order_id}) not applied: ${err.message}`);
      return 200;
    }
    console.error(`[payments] Webhook ${event.event} for ${payment.id} failed — Razorpay will retry:`, err);
    return 500;
  }
}

// ── Reconciling ──

/**
 * Ask Razorpay about unpaid orders opened in the last `days` (older than two minutes, so a player still
 * in Checkout isn't raced) and record any that were paid. Run every few minutes, and by Sync.
 */
export async function reconcileOpenOrders(days = 7) {
  const since = new Date(Date.now() - days * 86_400_000);
  const settled = new Date(Date.now() - 2 * 60_000);
  const open = await prisma.paymentOrder.findMany({
    where: { status: "CREATED", createdAt: { gte: since, lte: settled } },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { id: true },
  });
  const counts = { checked: open.length, recorded: 0, review: 0, unpaid: 0, errors: 0 };
  for (const { id } of open) {
    const r = await checkOrder(id, "RECONCILE");
    if (r === "RECORDED") counts.recorded++;
    else if (r === "REVIEW") counts.review++;
    else if (r === "ERROR") counts.errors++;
    else counts.unpaid++;
  }
  return counts;
}

/**
 * Admin "Sync with Razorpay": every captured (or authorized) payment of the last `days` in the Razorpay
 * account is matched to its order and recorded if it wasn't — including payments of orders opened before
 * order records were kept, or replaced by a newer order. Then the open orders are checked too.
 */
export async function syncWithRazorpay(days = 30) {
  const cleared = await clearFalseReviews();
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86_400;
  const counts = { payments: 0, recorded: 0, alreadyRecorded: 0, review: 0, notOurs: 0, errors: 0 };
  const problems: string[] = [];
  for (let skip = 0; skip < 10_000; skip += 100) {
    const { items } = await razorpay<{ items: GatewayPayment[] }>("GET", `/payments?from=${from}&to=${to}&count=100&skip=${skip}`);
    for (const p of items) {
      if ((p.status !== "captured" && p.status !== "authorized") || !p.order_id) continue;
      counts.payments++;
      try {
        const r = await recordPayment(p.order_id, p, "SYNC");
        if (r === "RECORDED") counts.recorded++;
        else if (r === "REVIEW") counts.review++;
        else counts.alreadyRecorded++;
      } catch (err) {
        if (err instanceof HttpError && err.message === "This payment doesn't belong to these entries.") counts.notOurs++;
        else {
          counts.errors++;
          if (problems.length < 20) problems.push(`${p.id}: ${err instanceof Error ? err.message : "failed"}`);
        }
      }
    }
    if (items.length < 100) break;
  }
  const open = await reconcileOpenOrders(days);
  return { ...counts, recorded: counts.recorded + open.recorded, review: counts.review + open.review, clearedReviews: cleared, problems };
}

/**
 * Review orders flagged "already paid — refund" although every entry was paid by this same payment (an
 * order recovered by Sync whose entries an earlier version had already marked paid). They are fine: mark
 * them PAID. A second payment for the same order, an amount mismatch or a removed entry stays for review.
 */
export async function clearFalseReviews(): Promise<number> {
  const orders = await prisma.paymentOrder.findMany({ where: { status: "REVIEW", paymentId: { not: null } } });
  let cleared = 0;
  for (const order of orders) {
    if (/second payment|removed|but the order was|don't match/i.test(order.note ?? "")) continue;
    const lines = linesOf(order);
    if (!lines.length || sum(lines) !== order.amount) continue;
    const paymentId = order.paymentId!;
    const done = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`pay:${order.id}`}))`;
      const entries = await tx.registration.findMany({ where: { id: { in: lines.map((l) => l.registrationId) } } });
      const handRecorded: typeof entries = [];
      for (const l of lines) {
        const e = entries.find((x) => x.id === l.registrationId);
        if (!e || e.paymentStatus !== "PAID") return false;
        if (e.razorpayPaymentId === paymentId) continue;
        if (e.paymentMode !== "RAZORPAY" && (await adminRecordedThisPayment(tx, e, paymentId))) { handRecorded.push(e); continue; }
        return false;
      }
      await adoptHandRecorded(tx, handRecorded, order.id, paymentId);
      const { count } = await tx.paymentOrder.updateMany({
        where: { id: order.id, status: "REVIEW" },
        data: {
          status: "PAID",
          note: handRecorded.length
            ? "Paid (an admin had recorded this same online payment by hand; entry switched to Online, a false \"already paid\" review was cleared)"
            : "Paid (recorded earlier by this same payment; a false \"already paid\" review was cleared)",
        },
      });
      return count > 0;
    });
    if (done) cleared++;
  }
  if (cleared) console.log(`[payments] Cleared ${cleared} false "already paid" review(s)`);
  return cleared;
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Entry = Awaited<ReturnType<typeof prisma.registration.findMany>>[number];

/**
 * An admin marked this entry paid by hand (cash/UPI/other) and their remark quotes this Razorpay payment ID
 * — i.e. they recorded the same online payment because it was still showing unpaid, not a second payment.
 */
async function adminRecordedThisPayment(tx: Tx, entry: Entry, paymentId: string) {
  const log = await tx.studentAuditLog.findFirst({
    where: {
      studentId: entry.studentId, action: "PAYMENT", actorType: "ADMIN",
      note: { contains: paymentId }, AND: [{ note: { contains: entry.weightCategory } }, { note: { contains: "Payment recorded by admin" } }],
    },
    select: { id: true },
  });
  return !!log;
}

/** Those entries were paid by the online payment: show them as paid online (logged in the audit trail). */
async function adoptHandRecorded(
  tx: Tx, entries: Entry[], orderId: string, paymentId: string,
  actor: Actor = { type: "ADMIN", name: "Sync with Razorpay" },
  note = `Recorded by hand earlier; matched to online payment ${paymentId} (no second payment — no refund due)`,
) {
  for (const e of entries) {
    const after = { paymentStatus: "PAID", paymentMode: "RAZORPAY", amountPaid: e.amountPaid, fee: e.fee, paidAt: e.paidAt };
    await tx.registration.update({ where: { id: e.id }, data: { paymentMode: "RAZORPAY", razorpayOrderId: orderId, razorpayPaymentId: paymentId } });
    const [student, tournament] = await Promise.all([
      tx.student.findUnique({ where: { id: e.studentId }, select: { id: true, studentNo: true, fullName: true } }),
      tx.tournament.findUnique({ where: { id: e.tournamentId }, select: { title: true } }),
    ]);
    if (student) {
      await recordPaymentAudit(tx, student, { ...e, tournament: tournament?.title ?? "" }, e, after, actor, note);
    }
  }
}

/**
 * An admin closes a review order. With `noRefund` (the player paid once, online): the order's entries that
 * were marked paid by hand (cash/UPI/other) are switched to Online and linked to the Razorpay payment, so
 * reports count them as online. Nothing is refunded and no amount changes. Returns how many were switched.
 */
export async function resolveReview(orderId: string, actor: Actor, note: string, noRefund: boolean): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`pay:${orderId}`}))`;
    const order = await tx.paymentOrder.findUnique({ where: { id: orderId } });
    if (!order || order.status !== "REVIEW") throw new HttpError(404, "No order to review with that id.");
    let switched: Entry[] = [];
    if (noRefund && order.paymentId) {
      const entries = await tx.registration.findMany({ where: { id: { in: linesOf(order).map((l) => l.registrationId) } } });
      switched = entries.filter((e) => e.paymentStatus === "PAID" && e.paymentMode !== "RAZORPAY");
      await adoptHandRecorded(tx, switched, order.id, order.paymentId, actor,
        `Switched to online payment ${order.paymentId} when the review was resolved (paid once online — no refund)`);
    }
    await tx.paymentOrder.update({
      where: { id: order.id },
      data: { status: "PAID", note: `${order.note}; resolved by ${actor.name}: ${note}${switched.length ? ` (${switched.length} entr${switched.length === 1 ? "y" : "ies"} switched to Online)` : ""}` },
    });
    return switched.length;
  });
}

/** Every few minutes, while online payment is on: the safety net for a lost browser call and a missed webhook. */
export function startPaymentReconciler(everyMinutes = 5) {
  if (!onlinePaymentEnabled()) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await reconcileOpenOrders();
      if (r.recorded || r.review || r.errors) console.log(`[payments] Automatic check: ${JSON.stringify(r)}`);
    } catch (err) {
      console.error("[payments] Automatic check failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, everyMinutes * 60_000).unref();
}
