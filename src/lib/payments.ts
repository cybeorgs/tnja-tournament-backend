import crypto from "crypto";
import Razorpay from "razorpay";
import { z } from "zod";
import prisma from "../db.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errors.js";
import { sendPaymentSuccess } from "./notifications.js";
import { repriceUnpaid } from "./fees.js";

let razorpay: Razorpay | null = null;
export function getRazorpay() {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) throw new HttpError(503, "Online payment is not set up. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to the backend .env, or mark the entry as paid manually.");
  razorpay ??= new Razorpay({ key_id: env.razorpayKeyId, key_secret: env.razorpayKeySecret });
  return razorpay;
}

// Payment flow and its safeguards:
//   • The amount is worked out on the server: each unpaid entry is first brought to the fee that
//     applies now (regular fee, or the admin's late fee after the regular deadline), and that amount is
//     locked into the order (orderFee).
//   • An entry is marked paid only after Razorpay's signature checks out AND the payment, fetched from
//     Razorpay itself, is captured, belongs to the order and is exactly the order's amount.
//   • The amount actually received is stored per entry, with the transaction ID and time.
//   • Before a new order is opened, earlier orders of the same entries are checked with Razorpay: if one
//     was paid (e.g. the tab closed before we heard back), it is recorded instead of charging again.

type GatewayPayment = { id: string; order_id: string; amount: number | string; status: string; created_at?: number };

/**
 * Mark an order's entries paid for a gateway payment, after checking the payment is captured, for this
 * order and of the exact amount. Only entries that weren't already paid change, and only those get the
 * payment-success email, so the same payment can be recorded twice without a second email.
 */
async function recordGatewayPayment(tournamentId: string, orderId: string, payment: GatewayPayment) {
  const registrations = await prisma.registration.findMany({ where: { tournamentId, razorpayOrderId: orderId }, select: { id: true, fee: true, orderFee: true } });
  if (!registrations.length) throw new HttpError(400, "This payment does not belong to this tournament.");
  if (payment.order_id !== orderId) throw new HttpError(400, "This payment is for a different order.");
  if (payment.status !== "captured" && payment.status !== "authorized") throw new HttpError(400, "The payment hasn't been completed.");

  const charged = (r: { fee: number; orderFee: number | null }) => r.orderFee ?? r.fee;
  const expectedPaise = registrations.reduce((sum, r) => sum + charged(r), 0) * 100;
  if (Number(payment.amount) !== expectedPaise) {
    console.error(`[payments] Amount mismatch on order ${orderId}: paid ${payment.amount}, expected ${expectedPaise} (payment ${payment.id})`);
    throw new HttpError(400, "The amount paid doesn't match the registration fee. Please contact the organiser with your transaction ID.");
  }

  const paidAt = payment.created_at ? new Date(payment.created_at * 1000) : new Date();
  const results = await prisma.$transaction(
    registrations.map((r) =>
      prisma.registration.updateMany({
        where: { id: r.id, paymentStatus: { not: "PAID" } },
        data: { paymentStatus: "PAID", paymentMode: "RAZORPAY", amountPaid: charged(r), fee: charged(r), razorpayPaymentId: payment.id, paidAt },
      }),
    ),
  );
  const newlyPaid = registrations.filter((_, i) => results[i]!.count > 0).map((r) => r.id);
  sendPaymentSuccess(newlyPaid, { transactionId: payment.id, orderId, paidAt }).catch((err) => console.error("[notifications] Payment email failed:", err));
  return registrations.map((r) => r.id);
}

/** Record any earlier order of these entries that Razorpay says was paid. Returns the ids now paid. */
async function settlePaidOrders(tournamentId: string, orderIds: string[]) {
  const settled: string[] = [];
  for (const orderId of orderIds) {
    try {
      const { items } = (await getRazorpay().orders.fetchPayments(orderId)) as unknown as { items: GatewayPayment[] };
      const captured = items.find((p) => p.status === "captured" || p.status === "authorized");
      if (captured) settled.push(...(await recordGatewayPayment(tournamentId, orderId, captured)));
    } catch (err) {
      console.error(`[payments] Could not check earlier order ${orderId}:`, err);
    }
  }
  return settled;
}

/**
 * Open one Razorpay order for a student's unpaid entries in a tournament (one per age group). Returns
 * null when there's nothing left to pay — e.g. an earlier payment turned out to have gone through.
 */
export async function createEntryOrder(
  registrations: { id: string }[],
  tournament: { id: string; title: string; registrationOpensAt: Date; registrationClosesAt: Date; startDate: Date; entryFee: number; lateEntryFee: number; status: string },
) {
  const ids = registrations.map((r) => r.id);
  const earlier = await prisma.registration.findMany({ where: { id: { in: ids }, paymentStatus: "PENDING", razorpayOrderId: { not: null } }, select: { razorpayOrderId: true } });
  await settlePaidOrders(tournament.id, [...new Set(earlier.map((r) => r.razorpayOrderId!))]);

  // The fee that applies now, from the tournament's settings.
  await repriceUnpaid(tournament);
  const toPay = await prisma.registration.findMany({ where: { id: { in: ids }, paymentStatus: "PENDING", fee: { gt: 0 } }, include: { student: true } });
  const first = toPay[0];
  if (!first) return null;
  const total = toPay.reduce((sum, r) => sum + r.fee, 0);

  const order = await getRazorpay().orders.create({
    amount: total * 100,
    currency: "INR",
    receipt: `reg_${first.id.slice(0, 30)}`,
    notes: { registrations: toPay.map((r) => r.id).join(",").slice(0, 250), tournament: tournament.title.slice(0, 200) },
  });
  await prisma.$transaction(toPay.map((r) => prisma.registration.update({ where: { id: r.id }, data: { razorpayOrderId: order.id, orderFee: r.fee } })));
  return { keyId: env.razorpayKeyId, orderId: order.id, amount: order.amount, currency: order.currency, name: first.student.fullName, phone: first.student.phone, entries: toPay.length };
}

export const verifySchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

/**
 * Verify a payment Checkout hands back: Razorpay's signature first, then the payment itself as
 * Razorpay reports it (captured, this order, exact amount). Returns the order's entries.
 */
export async function confirmOrderPayment(tournamentId: string, body: z.infer<typeof verifySchema>) {
  const razorpayClient = getRazorpay();
  const expected = crypto.createHmac("sha256", env.razorpayKeySecret).update(`${body.razorpay_order_id}|${body.razorpay_payment_id}`).digest("hex");
  const valid = expected.length === body.razorpay_signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(body.razorpay_signature));
  if (!valid) throw new HttpError(400, "Payment signature could not be verified.");

  let payment: GatewayPayment;
  try {
    payment = (await razorpayClient.payments.fetch(body.razorpay_payment_id)) as unknown as GatewayPayment;
  } catch (err) {
    console.error(`[payments] Could not fetch payment ${body.razorpay_payment_id}:`, err);
    throw new HttpError(502, "We couldn't confirm the payment with the payment gateway. If money was taken, it will show as paid shortly — please don't pay again.");
  }
  const ids = await recordGatewayPayment(tournamentId, body.razorpay_order_id, payment);
  return prisma.registration.findMany({ where: { id: { in: ids } }, include: { student: true } });
}
