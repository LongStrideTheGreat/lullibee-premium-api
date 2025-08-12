// api/paystack/confirm.js
import { getAdmin } from "../_admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { uid, reference, days, months } = req.body || {};
    if (!uid || !reference) {
      return res.status(400).json({ message: "uid and reference required" });
    }

    const secret = process.env.PAYSTACK_SECRET;
    if (!secret) return res.status(500).json({ message: "Missing PAYSTACK_SECRET" });

    // Verify with Paystack
    const r = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${secret}` }
    });
    const verify = await r.json();

    if (!verify?.status || verify?.data?.status !== "success") {
      return res.status(400).json({ message: "Payment not verified" });
    }

    const admin = getAdmin();
    const db = admin.firestore();

    const now = Date.now();
    // Prefer explicit days; fallback to months=1; final default 30 days
    const durationDays = Number.isFinite(days) ? Number(days)
                        : Number.isFinite(months) ? Number(months) * 30
                        : 30;

    const premiumExpiry = now + durationDays * 24 * 60 * 60 * 1000;

    await db.doc(`users/${uid}`).set(
      {
        plan: "premium",
        premiumSince: now,
        premiumExpiry, // number (ms)
      },
      { merge: true }
    );

    return res.json({ ok: true, premiumExpiry });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "server_error" });
  }
}
