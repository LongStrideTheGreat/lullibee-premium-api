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
    const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` }
    });
    const verify = await r.json();

    // Paystack returns: { status: true/false, data: { status: 'success' | ... } }
    if (!verify?.status || verify?.data?.status !== "success") {
      return res.status(400).json({ message: "Payment not verified" });
    }

    const admin = getAdmin();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    // Determine how many days to extend
    const viaDays = Number.isFinite(+days) ? +days : NaN;
    const viaMonths = Number.isFinite(+months) ? +months * 30 : NaN;
    const extendDays = Number.isFinite(viaDays)
      ? Math.max(1, viaDays)
      : Number.isFinite(viaMonths)
      ? Math.max(1, viaMonths)
      : 30; // default month

    const nowMs = Date.now();

    // Read current user to extend from existing premiumExpiry (if still active)
    const userRef = db.doc(`users/${uid}`);
    const snap = await userRef.get();
    const userData = snap.exists ? snap.data() : {};
    const currentExpiryMs = Number(userData?.premiumExpiry || 0);
    const base = currentExpiryMs > nowMs ? currentExpiryMs : nowMs;
    const newExpiryMs = base + extendDays * 24 * 60 * 60 * 1000;

    // Upsert a minimal payments ledger (idempotent by reference)
    const payRef = db.collection("payments").doc(String(reference));
    await payRef.set(
      {
        uid,
        reference: String(reference),
        status: "success",
        source: "client-confirm",
        createdAt: FieldValue.serverTimestamp(),
        processed: true,
        amount: verify?.data?.amount ?? null,   // in kobo/cents
        currency: verify?.data?.currency ?? "ZAR",
        email: verify?.data?.customer?.email ?? userData?.email ?? null,
      },
      { merge: true }
    );

    // Update user premium fields
    await userRef.set(
      {
        email: userData?.email || verify?.data?.customer?.email || null,
        plan: "premium",
        premiumSince: userData?.premiumSince || nowMs, // preserve first activation
        premiumExpiry: newExpiryMs,                    // store in ms
        lastPaymentRef: String(reference),
        lastPaymentAt: FieldValue.serverTimestamp(),
        lastPaymentAmount: verify?.data?.amount ?? null,
        lastPaymentCurrency: verify?.data?.currency ?? "ZAR",
        source: "paystack",
      },
      { merge: true }
    );

    return res.json({ ok: true, premiumExpiry: newExpiryMs, extendDays, baseFrom: base });
  } catch (e) {
    console.error("confirm error:", e);
    return res.status(500).json({ message: "server_error" });
  }
}
// hh