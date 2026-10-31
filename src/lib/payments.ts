import crypto from "crypto";
import Razorpay from "razorpay";
import { z } from "zod";
import prisma from "../db.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errors.js";

let razorpay: Razorpay | null = null;
export function getRazorpay() {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) throw new HttpError(503, "Online payment is not set up. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to the backend .env, or mark the entry as paid manually.");
  razorpay ??= new Razorpay({ key_id: env.razorpayKeyId, key_secret: env.razorpayKeySecret });
  return razorpay;
}

/** Create a Razorpay order for an entry's fee and remember it on the registration. */
export async function createEntryOrder(registration: { id: string; student: { fullName: string; phone: string } }, tournament: { title: string; entryFee: number }) {
  const order = await getRazorpay().orders.create({
    amount: tournament.entryFee * 100,
    currency: "INR",
    receipt: `reg_${registration.id.slice(0, 30)}`,
    notes: { registrationId: registration.id, tournament: tournament.title.slice(0, 200) },
  });
  await prisma.registration.update({ where: { id: registration.id }, data: { razorpayOrderId: order.id } });
  return { keyId: env.razorpayKeyId, orderId: order.id, amount: order.amount, currency: order.currency, name: registration.student.fullName, phone: registration.student.phone };
}

export const verifySchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

/** Check Razorpay's signature and mark the entry paid. */
export async function confirmEntryPayment(registration: { id: string; razorpayOrderId: string | null }, entryFee: number, body: z.infer<typeof verifySchema>) {
  getRazorpay();
  if (!registration.razorpayOrderId || registration.razorpayOrderId !== body.razorpay_order_id) {
    throw new HttpError(400, "This payment does not belong to this entry.");
  }
  const expected = crypto.createHmac("sha256", env.razorpayKeySecret).update(`${body.razorpay_order_id}|${body.razorpay_payment_id}`).digest("hex");
  const valid = expected.length === body.razorpay_signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(body.razorpay_signature));
  if (!valid) throw new HttpError(400, "Payment signature could not be verified.");

  return prisma.registration.update({
    where: { id: registration.id },
    data: { paymentStatus: "PAID", paymentMode: "RAZORPAY", amountPaid: entryFee, razorpayPaymentId: body.razorpay_payment_id, paidAt: new Date() },
    include: { student: true },
  });
}
