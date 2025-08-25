// api/play/verify-subscription.js
// Verify a Google Play SUBSCRIPTION and (optionally) update Firestore.
//
// Body (JSON or stringified JSON):
//   {
//     "packageName": "com.yourcompany.lullibee",  // optional; falls back to env PLAY_PACKAGE_NAME
//     "productId":   "lullibee_premium_monthly",  // required
//     "purchaseToken":"<token>",                   // required
//     "uid":         "<firebaseAuthUid>"           // optional: if provided, we'll flip premium in Firestore
//   }
//
// Headers (optional):
//   x-test-mode:    "true"  -> short-circuit; no Google call, no Firestore writes
//   x-acknowledge:  "true"  -> if active & unacknowledged, call subscriptions.acknowledge

import { google } from 'googleapis';

// -------- helpers --------
function send(res, code, body) {
  res.status(code);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseBody(maybe) {
  if (!maybe) return {};
  if (typeof maybe === 'string') {
    try { return JSON.parse(maybe); } catch { return {}; }
  }
  return maybe;
}

// ---- Firebase Admin (lazy singleton) ----
let _admin = null;
function getAdmin() {
  if (_admin) return _admin;

  const json =
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.GOOGLE_SA_JSON;
  if (!json) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT / GOOGLE_SA_JSON');

  const admin = require('firebase-admin');
  const creds = JSON.parse(json);

  try {
    admin.initializeApp({ credential: admin.credential.cert(creds) });
  } catch (_) {
    // App already initialized – ignore
  }

  _admin = admin;
  return _admin;
}

// ---- Google Android Publisher (lazy singleton) ----
let _publisher = null;
async function getAndroidPublisher() {
  if (_publisher) return _publisher;

  const json =
    process.env.GOOGLE_SA_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!json) throw new Error('Missing GOOGLE_SA_JSON / FIREBASE_SERVICE_ACCOUNT');

  const creds = JSON.parse(json);
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

export default async function handler(req, res) {
  // CORS & preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-test-mode, x-acknowledge');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
  }

  const testMode = String(req.headers['x-test-mode'] || '').toLowerCase() === 'true';
  const doAcknowledge = String(req.headers['x-acknowledge'] || '').toLowerCase() === 'true';

  try {
    const body = parseBody(req.body);

    const {
      packageName: bodyPackage,
      productId,
      purchaseToken,
      uid, // optional
    } = body || {};

    const packageName =
      bodyPackage ||
      process.env.PLAY_PACKAGE_NAME ||
      'com.yourcompany.lullibee';

    if (!productId || !purchaseToken) {
      return send(res, 400, { ok: false, error: 'Missing productId or purchaseToken.' });
    }

    // ---- TEST SHORT-CIRCUIT ----
    if (testMode) {
      return send(res, 200, {
        ok: true,
        test: true,
        packageName,
        productId,
        purchaseTokenPreview: purchaseToken.slice(0, 8) + '…',
        message: 'Connectivity OK (TEST MODE). No verification or writes performed.',
      });
    }

    // ---- Live verify with Google Play ----
    const publisher = await getAndroidPublisher();

    // purchases.subscriptions.get
    const { data } = await publisher.purchases.subscriptions.get({
      packageName,
      subscriptionId: productId,
      token: purchaseToken,
    });

    const now = Date.now();
    const expiryMs = Number(data.expiryTimeMillis || 0);
    const purchaseState = Number(data.purchaseState ?? -1); // 0 purchased
    const paymentState = Number(data.paymentState ?? -1);   // 2 paid, 3 trial
    const acknowledgementState = Number(data.acknowledgementState ?? -1);
    const isActive = expiryMs > now && purchaseState === 0;

    if (isActive && acknowledgementState === 0 && doAcknowledge) {
      try {
        await publisher.purchases.subscriptions.acknowledge({
          packageName,
          subscriptionId: productId,
          token: purchaseToken,
          requestBody: { developerPayload: 'ack-by-server' },
        });
      } catch (e) {
        console.warn('acknowledge failed:', e?.message || e);
      }
    }

    const response = {
      ok: true,
      verified: isActive,
      packageName,
      productId,
      autoRenewing: !!data.autoRenewing,
      expiryTimeMillis: expiryMs || null,
      expiryIso: expiryMs ? new Date(expiryMs).toISOString() : null,
      purchaseState,          // 0 purchased, 1 canceled, 2 pending
      paymentState,           // 1 pending, 2 received, 3 free trial, 4 pending deferred upgrade/downgrade
      acknowledgementState,   // 0 yet to be acknowledged, 1 acknowledged
      kind: data.kind || null,
      orderId: data.orderId || null,
      linkedPurchaseToken: data.linkedPurchaseToken || null,
    };

    // ---- Firestore flip (optional) ----
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
          expiryIso: response.expiryIso,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const receiptSnapshot = {
          purchaseState,
          paymentState,
          acknowledgementState,
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

        response.firestore = { updated: true, uid };
      } catch (e) {
        console.error('Firestore update failed:', e?.message || e);
        response.firestore = { updated: false, error: String(e) };
      }
    }

    return send(res, 200, response);
  } catch (err) {
    console.error('verify-subscription error:', err);
    return send(res, 500, { ok: false, error: 'VERIFY_SUBSCRIPTION_FAILED', detail: String(err) });
  }
}
