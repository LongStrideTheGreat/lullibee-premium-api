// api/paystack/initiate.js
// Initialize a Paystack payment on the server.
// Env: PAYSTACK_SECRET

import { getAdmin } from "../_admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { uid, email, amount, currency = "ZAR", days = 30 } = req.body || {};
    if (!uid || !email || !amount) {
      return res.status(400).json({ message: "uid, email, and amount are required" });
    }

    const secret = process.env.PAYSTACK_SECRET;
    if (!secret) return res.status(500).json({ message: "Missing PAYSTACK_SECRET" });

    // Paystack expects smallest currency unit (kobo/cents)
    const kobo = Math.round(Number(amount) * 100);
    if (!Number.isFinite(kobo) || kobo <= 0) {
      return res.status(400).json({ message: "Invalid amount" });
    }

    // Optional: define a redirect/callback URL (could be your app/site),
    // but we'll rely on the Webhook + client confirm for now.
    const payload = {
      email,
      amount: kobo,
      currency,
      // You can set a callback_url if you host a landing page:
      // callback_url: "https://your-site.com/paystack/return",
      metadata: {
        uid,
        days, // default duration for webhook if you use it
        // You can add anything else you want here:
        // plan: "monthly", source: "mobile"
      },
    };

    const r = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const json = await r.json();
    if (!json?.status) {
      return res.status(400).json({ message: json?.message || "init_failed" });
    }

    // Return only what the client needs
    return res.json({
      ok: true,
      authorization_url: json?.data?.authorization_url,
      reference: json?.data?.reference,
      access_code: json?.data?.access_code,
    });
  } catch (e) {
    console.error("initiate error:", e);
    return res.status(500).json({ message: "server_error" });
  }
}
