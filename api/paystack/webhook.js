// api/paystack/webhook.js
import crypto from "node:crypto";
import { getAdmin } from "../_admin.js";
import { readRaw } from "../_body.js";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const secret = process.env.PAYSTACK_SECRET;
    if (!secret) return res.status(500).json({ message: "Missing PAYSTACK_SECRET" });

    // Verify signature
    const raw = await readRaw(req);
    const headerSig = req.headers["x-paystack-signature"];
    const computedSig = crypto.createHmac("sha512", secret).update(raw).digest("hex");
    if (!headerSig || headerSig !== computedSig) {
      return res.status(200).json({ ok: false, error: "bad_signature" });
    }

    const body = JSON.parse(raw.toString("utf8") || "{}");
    const eventType = body?.event;
    const data = body?.data || {};

    // Only process success-ish events
    const successEvents = new Set([
      "charge.success",
      "subscription.create",
      "subscription.enable",
      "invoice.payment_success",
    ]);
    if (!successEvents.has(eventType)) {
      return res.status(200).json({ ok: true, skipped: true, event: eventType });
    }

    const uid = data?.metadata?.uid || data?.customer?.metadata?.uid || "";
    const reference = data?.reference || data?.subscription_code || String(data?.id || "");
    if (!uid || !reference) {
      return res.status(200).json({ ok: false, error: "missing_uid_or_ref" });
    }

    const admin = getAdmin();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    const userRef = db.doc(`users/${uid}`);
    const payRef = db.collection("payments").doc(String(reference));

    let alreadyProcessed = false;
    let newExpiryMs = 0;

    await db.runTransaction(async (tx) => {
      const paySnap = await tx.get(payRef);
      if (paySnap.exists && paySnap.data()?.processed) {
        alreadyProcessed = true;
        return;
      }

      const nowMs = Date.now();
      const extendDays = 30; // webhook default
      newExpiryMs = nowMs + extendDays * 24 * 60 * 60 * 1000;

      const uSnap = await tx.get(userRef);
      const current = uSnap.exists ? uSnap.data() : {};

      // 🔐 Overwrite policy: from NOW (non-stacking)
      tx.set(
        userRef,
        {
          plan: "premium",
          premiumSince: current?.premiumSince || nowMs,
          premiumExpiry: newExpiryMs,
          lastPaymentRef: String(reference),
          lastPaymentAt: FieldValue.serverTimestamp(),
          lastPaymentAmount: data?.amount ?? null,
          lastPaymentCurrency: data?.currency ?? "ZAR",
          source: "paystack",
          email: current?.email || data?.customer?.email || null,
        },
        { merge: true }
      );

      tx.set(
        payRef,
        {
          uid,
          reference: String(reference),
          status: "success",
          source: "webhook",
          amount: data?.amount ?? null,
          currency: data?.currency ?? "ZAR",
          email: data?.customer?.email ?? current?.email ?? null,
          processed: true,
          processedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
          lastEvent: eventType,
        },
        { merge: true }
      );
    });

    return res.status(200).json({ ok: true, uid, reference, newExpiryMs, alreadyProcessed });
  } catch (err) {
    console.error("Paystack webhook error:", err);
    return res.status(200).json({ ok: false, error: "internal" });
  }
}
