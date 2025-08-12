// api/paystack/confirm.js
import crypto from "node:crypto";
import { getAdmin } from "../_admin.js";
import { readJson } from "../_body.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { uid, reference, months = 1 } = await readJson(req);
    if (!uid || !reference) {
      return res.status(400).json({ error: "uid and reference required" });
    }

    const secret = process.env.PAYSTACK_SECRET;
    if (!secret) return res.status(500).json({ error: "Missing PAYSTACK_SECRET" });

    // Verify payment with Paystack
    const r = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${secret}` }
    });
    const verify = await r.json();

    if (!verify?.status || verify?.data?.status !== "success") {
      return res.status(400).json({ error: "Payment not verified" });
    }

    const admin = getAdmin();
    const db = admin.firestore();

    const now = Date.now();
    const m = Math.max(1, Number(months));
    const expiry = now + m * 30 * 24 * 60 * 60 * 1000;

    await db.doc(`users/${uid}`).set(
      { plan: "premium", premiumSince: now, premiumExpiry: expiry },
      { merge: true }
    );

    return res.json({ ok: true, premiumExpiry: expiry });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
}
