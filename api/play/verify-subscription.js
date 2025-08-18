// api/play/verify-subscription.js
// Verify a Google Play subscription token and activate Premium.
// Schema aligns with existing Paystack flow: plan/premiumSince/premiumExpiry fields.
// Env required:
//   GOOGLE_PLAY_PACKAGE_NAME
//   GOOGLE_PLAY_SA_CLIENT_EMAIL
//   GOOGLE_PLAY_SA_PRIVATE_KEY
// Optional:
//   ALLOWED_SKU_PREFIX (e.g. 'lullibee_premium_')
//   PREMIUM_DURATION_DAYS (fallback if Google expiry missing; default 30)

import { google } from "googleapis";
import { getAdmin } from "../_admin.js";

function isAllowedSku(productId) {
  const prefix = process.env.ALLOWED_SKU_PREFIX;
  if (!prefix) return true; // if not set, allow all
  return typeof productId === "string" && productId.startsWith(prefix);
}

function isActiveStateV2(subscriptionState) {
  if (!subscriptionState) return false;
  const v = String(subscriptionState).toUpperCase();
  // Allow ACTIVE and IN_GRACE_PERIOD for access
  return v.includes("ACTIVE") || v.includes("GRACE");
}

function pickV2ExpiryMillis(subData) {
  const li = subData?.lineItems?.[0];
  const expiry = li?.expiryTime; // milliseconds since epoch in string
  if (!expiry) return null;
  const n = Number(expiry);
  return Number.isFinite(n) ? n : null;
}

async function getPublisher() {
  const jwt = new google.auth.JWT({
    email: process.env.GOOGLE_PLAY_SA_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PLAY_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });

  return google.androidpublisher({
    version: "v3",
    auth: jwt,
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { uid, purchaseToken, productId, packageName } = req.body || {};
    if (!uid || !purchaseToken || !productId || !packageName) {
      return res.status(400).json({ ok: false, error: "Missing fields (uid, purchaseToken, productId, packageName)." });
    }

    if (!process.env.GOOGLE_PLAY_PACKAGE_NAME) {
      return res.status(500).json({ ok: false, error: "Missing GOOGLE_PLAY_PACKAGE_NAME" });
    }
    if (packageName !== process.env.GOOGLE_PLAY_PACKAGE_NAME) {
      return res.status(400).json({ ok: false, error: "Invalid packageName." });
    }
    if (!isAllowedSku(productId)) {
      return res.status(400).json({ ok: false, error: "SKU not allowed." });
    }

    const publisher = await getPublisher();

    // Subscriptions v2 verify:
    // https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get
    const subResp = await publisher.purchases.subscriptionsv2.get({
      packageName,
      token: purchaseToken,
    });
    const subData = subResp.data;

    const state = subData?.subscriptionState; // e.g., SUBSCRIPTION_STATE_ACTIVE
    const orderId = subData?.latestOrderId || null;
    const googleProductId = subData?.lineItems?.[0]?.productId || productId;

    if (!isActiveStateV2(state)) {
      return res.status(200).json({
        ok: false,
        verified: false,
        reason: `Subscription not active (state=${state || "UNKNOWN"})`,
        orderId,
      });
    }

    // Use Google's expiry when available; else fallback to N days
    const nowMs = Date.now();
    const googleExpiry = pickV2ExpiryMillis(subData);
    const fallbackDays = Number(process.env.PREMIUM_DURATION_DAYS || "30");
    const effectiveExpiryMs =
      googleExpiry && googleExpiry > nowMs
        ? googleExpiry
        : nowMs + fallbackDays * 24 * 60 * 60 * 1000;

    // Firestore update (align with existing Paystack schema)
    const admin = getAdmin();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    const userRef = db.doc(`users/${uid}`);

    // Use orderId when present, else purchaseToken, to keep idempotence in /payments
    const reference = String(orderId || purchaseToken);
    const payRef = db.collection("payments").doc(reference);

    let alreadyProcessed = false;

    await db.runTransaction(async (tx) => {
      const paySnap = await tx.get(payRef);
      if (paySnap.exists && paySnap.data()?.processed) {
        alreadyProcessed = true;
        return;
      }

      const uSnap = await tx.get(userRef);
      const current = uSnap.exists ? uSnap.data() : {};
      const now = Date.now();

      tx.set(
        userRef,
        {
          plan: "premium",
          premiumSince: Number.isFinite(current?.premiumSince) ? current.premiumSince : now,
          premiumExpiry: effectiveExpiryMs,
          lastPaymentRef: reference,
          lastPaymentAt: FieldValue.serverTimestamp(),
          lastPaymentAmount: null,
          lastPaymentCurrency: null,
          source: "google_play",
          // keep any existing email field; do not overwrite with null
        },
        { merge: true }
      );

      tx.set(
        payRef,
        {
          uid,
          reference,
          status: "success",
          source: "google_play_verify",
          amount: null,
          currency: null,
          productId: googleProductId,
          orderId,
          token: purchaseToken,
          processed: true,
          processedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
          lastEvent: "verify",
        },
        { merge: true }
      );
    });

    return res.status(200).json({
      ok: true,
      verified: true,
      uid,
      orderId,
      productId: googleProductId,
      subscriptionState: state,
      expiresAt: effectiveExpiryMs,
      alreadyProcessed,
    });
  } catch (err) {
    const msg = err?.errors?.[0]?.message || err?.message || "internal_error";
    console.error("play verify error:", msg);
    return res.status(500).json({ ok: false, error: msg });
  }
}
