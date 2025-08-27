// ESM + Vercel Node runtime
export const config = { runtime: "nodejs" };

import { google } from "googleapis";
import admin from "firebase-admin";

// ---- Firebase Admin (singleton) ----
function getAdmin() {
  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID || "";
    const clientEmail = process.env.SA_CLIENT_EMAIL || "";
    let privateKey = process.env.SA_PRIVATE_KEY || "";
    if (privateKey.includes("\\n")) privateKey = privateKey.replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error("Firebase Admin env missing (FIREBASE_PROJECT_ID / SA_CLIENT_EMAIL / SA_PRIVATE_KEY)");
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        project_id: projectId,
        client_email: clientEmail,
        private_key: privateKey,
      }),
    });
  }
  return admin;
}

// ---- Google Play (Android Publisher v3) ----
async function getAndroidPublisher() {
  const email = process.env.GOOGLE_PLAY_SA_CLIENT_EMAIL || "";
  let key = process.env.GOOGLE_PLAY_SA_PRIVATE_KEY || "";
  if (key.includes("\\n")) key = key.replace(/\\n/g, "\n");

  if (!email || !key) {
    throw new Error("Google Play SA env missing (GOOGLE_PLAY_SA_CLIENT_EMAIL / GOOGLE_PLAY_SA_PRIVATE_KEY)");
  }

  const jwt = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });

  // Surface auth/permission issues as 401/403 instead of late 500s
  await jwt.authorize();

  return google.androidpublisher({ version: "v3", auth: jwt });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    // plumbing test
    if (req.headers["x-test-mode"] === "true") {
      return res.status(200).json({ ok: true, test: true, saw: req.body || {} });
    }

    const {
      platform = "android",
      packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME,
      productId,
      purchaseToken,
      uid,
    } = req.body || {};

    if (platform !== "android") return res.status(400).json({ ok: false, error: "Only Android supported" });
    if (!uid) return res.status(400).json({ ok: false, error: "Missing uid" });
    if (!packageName) return res.status(400).json({ ok: false, error: "Missing packageName" });
    if (!purchaseToken) return res.status(400).json({ ok: false, error: "Missing purchaseToken" });

    const allowedPrefix = process.env.ALLOWED_SKU_PREFIX;
    if (allowedPrefix && productId && !String(productId).startsWith(allowedPrefix)) {
      return res.status(400).json({ ok: false, error: "SKU not allowed" });
    }

    const androidpublisher = await getAndroidPublisher();

    let active = false;
    let expiryMs = null;
    let kind = "subscription";

    // --- Try Subscriptions v2 ---
    let subTried = false;
    try {
      subTried = true;
      const subRes = await androidpublisher.purchases.subscriptionsv2.get({
        packageName,
        token: purchaseToken,
      });
      const data = subRes.data || {};
      const line = Array.isArray(data.lineItems) ? data.lineItems[0] : null;
      expiryMs = Number(line?.expiryTime || 0);
      active = Number.isFinite(expiryMs) && expiryMs > Date.now();

      // Best-effort acknowledge (no-op if already acked)
      if (active && productId) {
        try {
          await androidpublisher.purchases.subscriptions.acknowledge({
            packageName,
            subscriptionId: productId,
            token: purchaseToken,
            requestBody: {},
          });
        } catch (e) {
          console.log("[acknowledge] warning:", e?.message || String(e));
        }
      }
    } catch (_) {
      // not a subscription? fall through to product
    }

    // --- Fallback: one-time Product purchase ---
    if (!active) {
      try {
        const prodRes = await androidpublisher.purchases.products.get({
          packageName,
          productId: productId || "",
          token: purchaseToken,
        });
        const p = prodRes.data || {};
        // 0=purchased, 1=canceled, 2=pending
        if (p.purchaseState === 0) {
          active = true;
          expiryMs = null;
          kind = "product";
        }
      } catch (_) {
        // ignore; we'll return 402 below
      }
    }

    if (!active) {
      return res.status(402).json({ ok: false, error: "Verification failed", details: "token not valid/active", kind });
    }

    // Write entitlement
    const adminSdk = getAdmin();
    const db = adminSdk.firestore();
    await db.collection("users").doc(uid).set(
      {
        premium: {
          active: true,
          source: "play",
          sku: productId || null,
          kind, // "subscription" | "product"
          updatedAt: adminSdk.firestore.FieldValue.serverTimestamp(),
          expiresAt: expiryMs ? adminSdk.firestore.Timestamp.fromMillis(expiryMs) : null,
          expiryTimeMillis: expiryMs || null,
        },
      },
      { merge: true }
    );

    return res.status(200).json({
      ok: true,
      summary: { kind, isActive: true, expiryTimeMillis: expiryMs },
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/unauthorized|invalid_grant|not found|permission|insufficient|forbidden/i.test(msg)) {
      return res.status(401).json({ ok: false, error: "Play auth/permission", details: msg });
    }
    console.error("[verify-subscription] 500:", msg);
    return res.status(500).json({ ok: false, error: "Function_invocation_failed", details: msg });
  }
}
