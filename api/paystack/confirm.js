// api/paystack/confirm.js
import { getAdmin } from "../_admin.js";

/**
 * Confirms a Paystack transaction and activates Premium for exactly N days
 * from NOW (no stacking). Idempotent by payment reference.
 *
 * Body: { uid: string, reference: string, days?: number, months?: number }
 */
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
    const r = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secret}` } }
    );
    const verify = await r.json();

    if (!verify?.status || verify?.data?.status !== "success") {
      return res.status(400).json({ message: "Payment not verified" });
    }

    const admin = getAdmin();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    // Duration: default 30d; allow custom
    const viaDays = Number.isFinite(+days) ? +days : NaN;
    const viaMonths = Number.isFinite(+months) ? +months * 30 : NaN;
    const extendDays = Number.isFinite(viaDays)
      ? Math.max(1, viaDays)
      : Number.isFinite(viaMonths)
      ? Math.max(1, viaMonths)
      : 30;

    const nowMs = Date.now();
    const newExpiryMs = nowMs + extendDays * 24 * 60 * 60 * 1000;

    const userRef = db.doc(`users/${uid}`);
    const payRef = db.collection("payments").doc(String(reference));

    let alreadyProcessed = false;

    await db.runTransaction(async (tx) => {
      const paySnap = await tx.get(payRef);
      if (paySnap.exists && paySnap.data()?.processed) {
        alreadyProcessed = true;
        return;
      }

      const userSnap = await tx.get(userRef);
      const current = userSnap.exists ? userSnap.data() : {};

      // 🔐 Overwrite policy: from NOW (non-stacking)
      tx.set(
        userRef,
        {
          plan: "premium",
          premiumSince: current?.premiumSince || nowMs,
          premiumExpiry: newExpiryMs, // ms since epoch
          lastPaymentRef: String(reference),
          lastPaymentAt: FieldValue.serverTimestamp(),
          lastPaymentAmount: verify?.data?.amount ?? null,
          lastPaymentCurrency: verify?.data?.currency ?? "ZAR",
          source: "paystack",
          email: current?.email || verify?.data?.customer?.email || null,
        },
        { merge: true }
      );

      // Mark reference processed → idempotence
      tx.set(
        payRef,
        {
          uid,
          reference: String(reference),
          status: "success",
          source: "client-confirm",
          amount: verify?.data?.amount ?? null,
          currency: verify?.data?.currency ?? "ZAR",
          email: verify?.data?.customer?.email ?? current?.email ?? null,
          processed: true,
          processedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    return res.json({ ok: true, premiumExpiry: newExpiryMs, alreadyProcessed });
  } catch (e) {
    console.error("confirm error:", e);
    return res.status(500).json({ message: "server_error" });
  }
}
