// api/play/verify-subscription.js
// Verifies a Google Play SUBSCRIPTION and (optionally) updates Firestore.
//
// Body:
// {
//   "packageName": "com.yourcompany.lullibee",        // optional; falls back to env PLAY_PACKAGE_NAME
//   "productId":   "lullibee_premium_monthly",        // required
//   "purchaseToken":"<token>",                         // required
//   "uid":         "<firebaseAuthUid>"                 // optional: if provided, we'll flip premium in Firestore
// }
//
// Headers (optional):
//   x-test-mode: "true"        -> short-circuit with a safe stub; no Firestore writes
//   x-acknowledge: "true"      -> if not acknowledged, call purchases.subscriptions.acknowledge

import { google } from 'googleapis';

// ---- Firebase Admin (lazy singleton) ----
let _admin = null;
function getAdmin() {
  if (_admin) return _admin;
  // Allow either FIREBASE_SERVICE_ACCOUNT (full admin JSON) or GOOGLE_SA_JSON (same object)
  const svc =
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.GOOGLE_SA_JSON;
  if (!svc) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT / GOOGLE_SA_JSON env');
  }
  // Avoid re-init if hot reloaded
  const g = globalThis.__fbadmin || {};
  if (!g.app) {
    const admin = require('firebase-admin');
    const creds = JSON.parse(svc);
    try {
      admin.initializeApp({
        credential: admin.credential.cert(creds),
      });
    } catch (e) {
      // ignore "already exists"
    }
    g.app = true;
    g.admin = admin;
    globalThis.__fbadmin = g;
  }
  _admin = globalThis.__fbadmin.admin;
  return _admin;
}

// ---- Google Android Publisher (lazy) ----
let _publisher = null;
async function getAndroidPublisher() {
  if (_publisher) return _publisher;
  const svc =
    process.env.GOOGLE_SA_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!svc) throw new Error('Missing GOOGLE_SA_JSON / FIREBASE_SERVICE_ACCOUNT env');
  const creds = JSON.parse(svc);

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: creds.client_email,
      private_key: creds.private_key,
    },
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  const client = await auth.getClient();
  _publisher = google.androidpublisher({ version: 'v3', auth: client });
  return _publisher;
}

function json(res, code, body) {
  res.status(code).setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const testMode = String(req.headers['x-test-mode'] || '').toLowerCase() === 'true';
  const doAcknowledge = String(req.headers['x-acknowledge'] || '').toLowerCase() === 'true';

  try {
    const {
      packageName: bodyPackage,
      productId,
      purchaseToken,
      uid,                                  // optional
    } = (req.body || {});

    const packageName =
      bodyPackage ||
      process.env.PLAY_PACKAGE_NAME ||
      'com.yourcompany.lullibee';

    if (!productId || !purchaseToken) {
      return json(res, 400, { error: 'Missing productId or purchaseToken' });
    }

    // ---- TEST SHORT-CIRCUIT (no external calls, no writes) ----
    if (testMode) {
      return json(res, 200, {
        ok: true,
        test: true,
        packageName,
        productId,
        purchaseTokenPreview: purchaseToken.slice(0, 8) + '…',
        message: 'Connectivity OK (TEST MODE). No verification performed.',
      });
    }

    const publisher = await getAndroidPublisher();

    // Verify subscription token with Google Play
    // https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/get
    const { data } = await publisher.purchases.subscriptions.get({
      packageName,
      subscriptionId: productId,
      token: purchaseToken,
    });

    // data includes fields like:
    // purchaseState (0 purchased, 1 canceled, 2 pending),
    // paymentState (1 pending, 2 received, 3 free trial, 4 pending deferred upgrade/downgrade),
    // acknowledgementState (0 yet to be acknowledged, 1 acknowledged),
    // expiryTimeMillis,
    // autoRenewing, etc.
    const now = Date.now();
    const expiryMs = Number(data.expiryTimeMillis || 0);
    const isActive = expiryMs > now && String(data.purchaseState) === '0';

    // Optionally acknowledge (good hygiene; otherwise client can acknowledge)
    if (isActive && data.acknowledgementState === 0 && doAcknowledge) {
      try {
        await publisher.purchases.subscriptions.acknowledge({
          packageName,
          subscriptionId: productId,
          token: purchaseToken,
          requestBody: { developerPayload: 'ack-by-server' },
        });
      } catch (e) {
        // Non-fatal; include info in response
        console.warn('acknowledge failed:', e?.message || e);
      }
    }

    // ---- Prepare response summary ----
    const summary = {
      ok: true,
      verified: isActive,
      packageName,
      productId,
      autoRenewing: !!data.autoRenewing,
      expiryTimeMillis: expiryMs || null,
      expiryIso: expiryMs ? new Date(expiryMs).toISOString() : null,
      purchaseState: Number(data.purchaseState ?? -1),
      paymentState: Number(data.paymentState ?? -1),
      acknowledgementState: Number(data.acknowledgementState ?? -1),
      kind: data.kind || null,
      orderId: data.orderId || null,
      linkedPurchaseToken: data.linkedPurchaseToken || null,
    };

    // ---- Firestore flip (only if uid provided) ----
    if (uid) {
      try {
        const admin = getAdmin();
        const db = admin.firestore();

        const userRef = db.collection('users').doc(uid);
        const premium = {
          active: !!isActive,
          source: 'google_play',
          productId,
          packageName,
          autoRenewing: !!data.autoRenewing,
          expiryTimeMillis: expiryMs || null,
          expiryIso: summary.expiryIso,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // Store a copy of raw receipt fields for audit/debug
        const receiptSnapshot = {
          purchaseState: Number(data.purchaseState ?? -1),
          paymentState: Number(data.paymentState ?? -1),
          acknowledgementState: Number(data.acknowledgementState ?? -1),
          kind: data.kind || null,
          orderId: data.orderId || null,
          linkedPurchaseToken: data.linkedPurchaseToken || null,
        };

        await userRef.set(
          {
            premium,
            billing: {
              googlePlay: {
                productId,
                packageName,
                expiryTimeMillis: expiryMs || null,
                autoRenewing: !!data.autoRenewing,
                lastReceipt: receiptSnapshot,
                lastVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
            },
          },
          { merge: true }
        );

        summary.firestore = { updated: true, uid };
      } catch (e) {
        console.error('Firestore update failed:', e?.message || e);
        summary.firestore = { updated: false, error: String(e) };
      }
    }

    return json(res, 200, summary);
  } catch (err) {
    console.error('verify-subscription error:', err);
    return json(res, 500, { error: 'VERIFY_SUBSCRIPTION_FAILED', detail: String(err) });
  }
}
