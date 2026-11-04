// ─── Online entry-fee payments (Razorpay) ────────────────────────────────────
// A student pays all their unpaid entries in a tournament in one go: right after registering (the
// registration reply carries a short-lived pay token), or later from their student login. Either way
// the same steps run, and paying the last unpaid entry emails the hall ticket.
//
// Safeguards:
//   • The amount is worked out on the server from the entries' fees and locked into the order (orderFee).
//   • An entry is marked paid only after Razorpay's signature checks out AND the payment, fetched from
//     Razorpay itself, is captured, belongs to the order and is exactly the order's amount.
//   • Before a new order is opened, earlier orders of the same entries are checked with Razorpay: if one
//     was paid (e.g. the tab closed before we heard back), it is recorded instead of charging again.
//   • Payments are accepted until the tournament starts (registration itself closes earlier).
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import prisma from "../db.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errors.js";
import { sendHallTicketLater } from "./hallTicket.js";
import { repriceEntries } from "./fees.js";

export const onlinePaymentEnabled = () => !!env.razorpayKeyId && !!env.razorpayKeySecret;

// ── Razorpay REST API (no SDK needed: three calls) ──

type GatewayPayment = { id: string; order_id: string; amount: number; status: string; created_at?: number };
type GatewayOrder = { id: string; amount: number; currency: string };

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

// ── Recording a payment ──

/**
 * Mark an order's entries paid, after checking the payment is captured, for this order and of the
 * exact amount. Entries already paid are left alone, so recording the same payment twice is harmless.
 */
async function recordPayment(tournamentId: string, studentId: string, orderId: string, payment: GatewayPayment) {
  const entries = await prisma.registration.findMany({ where: { tournamentId, studentId, razorpayOrderId: orderId }, select: { id: true, fee: true, orderFee: true } });
  if (!entries.length) throw new HttpError(400, "This payment doesn't belong to these entries.");
  if (payment.order_id !== orderId) throw new HttpError(400, "This payment is for a different order.");

  let captured = payment;
  if (payment.status === "authorized") {
    // Accounts without auto-capture: capture it now, or Razorpay refunds it after a few days.
    captured = await razorpay<GatewayPayment>("POST", `/payments/${encodeURIComponent(payment.id)}/capture`, { amount: payment.amount, currency: "INR" });
  }
  if (captured.status !== "captured") throw new HttpError(400, "The payment hasn't been completed.");

  const charged = (r: { fee: number; orderFee: number | null }) => r.orderFee ?? r.fee;
  const expectedPaise = entries.reduce((sum, r) => sum + charged(r), 0) * 100;
  if (Number(captured.amount) !== expectedPaise) {
    console.error(`[payments] Amount mismatch on order ${orderId}: paid ${captured.amount}, expected ${expectedPaise} (payment ${captured.id})`);
    throw new HttpError(400, "The amount paid doesn't match the entry fee. Please contact the organiser with your transaction ID.");
  }

  const paidAt = captured.created_at ? new Date(captured.created_at * 1000) : new Date();
  await prisma.$transaction(
    entries.map((r) =>
      prisma.registration.updateMany({
        where: { id: r.id, paymentStatus: "PENDING" },
        data: { paymentStatus: "PAID", paymentMode: "RAZORPAY", amountPaid: charged(r), fee: charged(r), razorpayPaymentId: captured.id, paidAt },
      }),
    ),
  );
  sendHallTicketLater(tournamentId, studentId);
}

/** Record any earlier order of these entries that Razorpay says was paid (so nobody pays twice). */
async function settleEarlierOrders(tournamentId: string, studentId: string) {
  const earlier = await prisma.registration.findMany({
    where: { tournamentId, studentId, paymentStatus: "PENDING", razorpayOrderId: { not: null } },
    select: { razorpayOrderId: true },
    distinct: ["razorpayOrderId"],
  });
  for (const { razorpayOrderId } of earlier) {
    try {
      const { items } = await razorpay<{ items: GatewayPayment[] }>("GET", `/orders/${encodeURIComponent(razorpayOrderId!)}/payments`);
      const paid = items.find((p) => p.status === "captured" || p.status === "authorized");
      if (paid) await recordPayment(tournamentId, studentId, razorpayOrderId!, paid);
    } catch (err) {
      console.error(`[payments] Could not check earlier order ${razorpayOrderId}:`, err);
    }
  }
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
  const total = toPay.reduce((sum, r) => sum + r.fee, 0);

  const order = await razorpay<GatewayOrder>("POST", "/orders", {
    amount: total * 100,
    currency: "INR",
    receipt: `reg_${first.id.replace(/-/g, "").slice(0, 30)}`,
    notes: { tournament: tournament.title.slice(0, 200), student: `${first.student.studentNo ?? ""} ${first.student.fullName}`.trim().slice(0, 200), entries: String(toPay.length) },
  });
  await prisma.$transaction(toPay.map((r) => prisma.registration.update({ where: { id: r.id }, data: { razorpayOrderId: order.id, orderFee: r.fee } })));
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

/** Step 2: what Checkout hands back. Razorpay's signature first, then the payment as Razorpay reports it. */
export async function confirmPayment(tournamentId: string, studentId: string, body: z.infer<typeof verifySchema>) {
  const expected = crypto.createHmac("sha256", env.razorpayKeySecret).update(`${body.razorpay_order_id}|${body.razorpay_payment_id}`).digest("hex");
  const valid = expected.length === body.razorpay_signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(body.razorpay_signature));
  if (!valid) throw new HttpError(400, "The payment couldn't be verified.");

  const payment = await razorpay<GatewayPayment>("GET", `/payments/${encodeURIComponent(body.razorpay_payment_id)}`).catch(() => {
    throw new HttpError(502, "We couldn't confirm the payment with the gateway. If money was taken, it will show as paid shortly — please don't pay again.");
  });
  await recordPayment(tournamentId, studentId, body.razorpay_order_id, payment);
  return prisma.registration.findMany({ where: { tournamentId, studentId }, orderBy: { createdAt: "asc" } });
}
