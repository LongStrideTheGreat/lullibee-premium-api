// api/paystack/webhook.js
// Verifies x-paystack-signature, writes payments/{reference} idempotently,
// and activates/extends Premium (+30 days by default).

import crypto from "node:crypto";
import { getAdmin } from "../_admin.js";
import { readRaw } from "../_body.js";

// ✅ IMPORTANT for Next.js / Vercel so we can read the raw body:
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const secret = process.env.PAYSTACK_SECRET;
    if (!secret) return res.status(500).json({ ok: false, error: "Missing PAYSTACK_SECRET" });

    const raw = await readRaw(req);                       // Buffer
    const headerSig = req.headers["x-paystack-signature"];
    const computedSig = crypto.createHmac("sha512", secret).update(raw).digest("hex");

    // Parse AFTER verifying from raw
    const event = JSON.parse(raw.toString("utf8"));
    const eventType = event?.event || "";
    const data = event?.data || {};
    const reference = data?.reference || data?.subscription_code || String(data?.id || "");

    // Admin SDK
    const admin = getAdmin();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    // ✳️ Minimal trace (temporary; remove later if you want)
    await db.collection("webhook_traces").add({
      ts: FieldValue.serverTimestamp(),
      okSignature: Boolean(headerSig && headerSig === computedSig),
      event: eventType || null,
      reference: reference || null,
      email: data?.customer?.email || null,
      mode: process.env.PAYSTACK_SECRET?.startsWith("sk_test_") ? "test" : "live",
    });

    // If signature invalid, do NOT process. Return 200 to avoid retries leaking info.
    if (!headerSig || headerSig !== computedSig) {
      return res.status(200).json({ ok: false, reason: "bad-signature" });
    }

    // Only process successful charge/renewal events
    const isSuccess =
      eventType === "charge.success" ||
      eventType === "invoice.payment_success" ||
      data?.status === "success";
    if (!isSuccess) {
      // Store minimal record and exit
      if (reference) {
        await db.collection("payments").doc(String(reference)).set(
          {
            eventType,
            status: data?.status || "unknown",
            createdAt: FieldValue.serverTimestamp(),
            rawSummary: {
              amount: data?.amount ?? null,
              currency: data?.currency ?? "ZAR",
              email: data?.customer?.email ?? null,
            },
            processed: false,
          },
          { merge: true }
        );
      }
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (!reference) {
      return res.status(200).json({ ok: false, reason: "no-reference" });
    }

    // Idempotency guard
    const payRef = db.collection("payments").doc(String(reference));
    const paySnap = await payRef.get();
    if (paySnap.exists && paySnap.data()?.processed === true) {
      return res.status(200).json({ ok: true, idempotent: true });
    }

    // Resolve user: prefer metadata.uid, fallback to email lookup
    let uid = data?.metadata?.uid || null;
    if (!uid) {
      const email = data?.customer?.email;
      if (email) {
        const q = await db.collection("users").where("email", "==", email).limit(1).get();
        if (!q.empty) uid = q.docs[0].id;
      }
    }
    if (!uid) {
      await payRef.set(
        {
          reference,
          eventType,
          status: data?.status || "success",
          createdAt: FieldValue.serverTimestamp(),
          rawSummary: {
            amount: data?.amount ?? null,
            currency: data?.currency ?? "ZAR",
            email: data?.customer?.email ?? null,
          },
          processed: false,
          reason: "no-uid",
        },
        { merge: true }
      );
      return res.status(200).json({ ok: false, reason: "no-uid" });
    }

    // Duration: metadata.days, or metadata.months*30, else 30
    const md = data?.metadata || {};
    const daysFromMeta =
      (Number.isFinite(+md.days) && +md.days) ||
      (Number.isFinite(+md.months) && +md.months * 30);
    const extendDays = daysFromMeta && daysFromMeta > 0 ? daysFromMeta : 30;

    const nowMs = Date.now();

    // Read current expiry to extend correctly
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const currentExpiryMs = Number(userData?.premiumExpiry || 0);
    const base = currentExpiryMs > nowMs ? currentExpiryMs : nowMs;
    const newExpiryMs = base + extendDays * 24 * 60 * 60 * 1000;

    // Write payment ledger (idempotent)
    await payRef.set(
      {
        uid,
        reference,
        eventType,
        status: data?.status || "success",
        amount: data?.amount ?? null,    // cents
        currency: data?.currency ?? "ZAR",
        email: data?.customer?.email ?? null,
        createdAt: FieldValue.serverTimestamp(),
        processed: true,
      },
      { merge: true }
    );

    // Update user premium fields
    await userRef.set(
      {
        email: userData?.email || data?.customer?.email || null,
        plan: "premium",
        premiumSince: userData?.premiumSince || nowMs,  // keep first activation
        premiumExpiry: newExpiryMs,
        lastPaymentRef: reference,
        lastPaymentAt: FieldValue.serverTimestamp(),
        lastPaymentAmount: data?.amount ?? null,
        lastPaymentCurrency: data?.currency ?? "ZAR",
        source: "paystack",
      },
      { merge: true }
    );

    return res.status(200).json({ ok: true, uid, reference, newExpiryMs });
  } catch (err) {
    console.error("Paystack webhook error:", err);
    return res.status(200).json({ ok: false, error: "internal" }); // keep 200 to avoid retry storms
  }
}
