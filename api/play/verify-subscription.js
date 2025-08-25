// /api/play/verify-subscription.js
// Unified, resilient Google Play subscription verification for Vercel/Node 18+ (OpenSSL 3).
import { google } from 'googleapis';
import admin from 'firebase-admin';

/* ---------------- Helpers ---------------- */
function send(res, code, body) {
  res.status(code).setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
function parseBody(maybe) {
  if (!maybe) return {};
  if (typeof maybe === 'string') {
    try { return JSON.parse(maybe); } catch { return {}; }
  }
  return maybe;
}
function getEnv(name, fallback = undefined) {
  const v = process.env[name];
  return typeof v === 'string' && v.length ? v : fallback;
}
// Fix escaped newlines in env private keys (Vercel)
function fixKey(k) {
  return (k || '').replace(/\\n/g, '\n');
}

/* ------------- Firebase Admin (singleton) ------------- */
function ensureAdmin() {
  if (!admin.apps.length) {
    // Option A: whole SA JSON in one env
    const jsonStr = getEnv('GOOGLE_SA_JSON') || getEnv('FIREBASE_SERVICE_ACCOUNT');
    if (jsonStr) {
      const creds = JSON.parse(jsonStr);
      admin.initializeApp({ credential: admin.credential.cert(creds) });
    } else {
      // Option B: split envs
      const clientEmail =
        getEnv('GOOGLE_PLAY_SA_CLIENT_EMAIL') ||
        getEnv('GOOGLE_SA_CLIENT_EMAIL') ||
        getEnv('FIREBASE_SA_CLIENT_EMAIL') ||
        getEnv('SA_CLIENT_EMAIL');
      const privateKey = fixKey(
        getEnv('GOOGLE_PLAY_SA_PRIVATE_KEY') ||
        getEnv('GOOGLE_SA_PRIVATE_KEY') ||
        getEnv('FIREBASE_SA_PRIVATE_KEY') ||
        getEnv('SA_PRIVATE_KEY')
      );
      const projectId =
        getEnv('FIREBASE_PROJECT_ID') ||
        getEnv('GOOGLE_SA_PROJECT_ID') ||
        getEnv('GCLOUD_PROJECT');

      if (!clientEmail || !privateKey) {
        throw new Error('Missing Firebase Admin credentials');
      }
      admin.initializeApp({
        credential: admin.credential.cert({ clientEmail, privateKey, projectId }),
      });
    }
  }
  return admin;
}

/* --------- Google Android Publisher (singleton) --------- */
let publisherPromise = null;
function ensurePublisher() {
  if (!publisherPromise) {
    publisherPromise = (async () => {
      const email =
        getEnv('GOOGLE_PLAY_SA_CLIENT_EMAIL') ||
        getEnv('ANDROID_PUBLISHER_CLIENT_EMAIL') ||
        getEnv('GOOGLE_SA_CLIENT_EMAIL') ||
        getEnv('SA_CLIENT_EMAIL');
      const key = fixKey(
        getEnv('GOOGLE_PLAY_SA_PRIVATE_KEY') ||
        getEnv('ANDROID_PUBLISHER_PRIVATE_KEY') ||
        getEnv('GOOGLE_SA_PRIVATE_KEY') ||
        getEnv('SA_PRIVATE_KEY')
      );
      if (!email || !key) throw new Error('Missing Google Play service account credentials');

      const jwt = new google.auth.JWT({
        email,
        key,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });

      return google.androidpublisher({ version: 'v3', auth: jwt });
    })();
  }
  return publisherPromise;
}

/* ------------------- Config ------------------- */
const PLAY_PACKAGE_NAME = getEnv('PLAY_PACKAGE_NAME') || getEnv('GOOGLE_PLAY_PACKAGE_NAME');
const ALLOWED_PRODUCTS = new Set([
  'lullibee_premium_monthly',
  // add more SKUs if you sell them
]);

/* ------------------- Handler ------------------- */
export default async function handler(req, res) {
  // CORS & preflight (optional)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-test-mode');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });

  const testMode = String(req.headers['x-test-mode'] || '').toLowerCase() === 'true';
  const body = parseBody(req.body);

  const {
    platform = 'android',
    packageName: bodyPackage,
    productId,
    purchaseToken,
    uid,
  } = body || {};

  if (platform !== 'android') return send(res, 400, { ok: false, error: 'Only Android supported' });

  const packageName = bodyPackage || PLAY_PACKAGE_NAME;
  if (!packageName) return send(res, 400, { ok: false, error: 'Missing packageName/PLAY_PACKAGE_NAME' });
  if (!productId) return send(res, 400, { ok: false, error: 'Missing productId' });
  if (!ALLOWED_PRODUCTS.has(productId)) return send(res, 400, { ok: false, error: `Unknown productId: ${productId}` });
  if (!purchaseToken) return send(res, 400, { ok: false, error: 'Missing purchaseToken' });

  if (testMode) {
    return send(res, 200, { ok: true, test: true, packageName, productId, purchaseTokenPreview: purchaseToken.slice(0, 8) + '…' });
  }

  let data = null;
  try {
    const adminApp = ensureAdmin();
    const publisher = await ensurePublisher();

    const resp = await publisher.purchases.subscriptions.get({
      packageName,
      subscriptionId: productId,
      token: purchaseToken,
    });
    data = resp.data || {};

    const nowMs = Date.now();
    const expiryTimeMillis = Number(data.expiryTimeMillis || 0);
    const purchaseState = Number(data.purchaseState ?? -1);        // 0 = purchased
    const paymentState = Number(data.paymentState ?? -1);          // 2 = paid, 3 = trial
    const acknowledgementState = Number(data.acknowledgementState ?? -1);
    const isActive = expiryTimeMillis > nowMs && purchaseState === 0;

    // Acknowledge if needed
    if (isActive && acknowledgementState === 0) {
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

    // Optional: write entitlement
    let firestore = { updated: false };
    if (uid) {
      try {
        const db = adminApp.firestore();
        const userRef = db.doc(`users/${uid}`);

        const premium = {
          active: !!isActive,
          // Write BOTH for app compatibility:
          expiresAt: expiryTimeMillis || 0,       // number (ms) your app can read
          expiryTimeMillis: expiryTimeMillis || 0 // legacy/alternate
        };

        const audit = {
          purchaseState,
          paymentState,
          acknowledgementState,
          orderId: data.orderId || null,
          packageName,
          productId,
          autoRenewing: !!data.autoRenewing,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await userRef.set(
          { premium, billing: { googlePlay: audit } },
          { merge: true }
        );

        firestore = { updated: true };
      } catch (e) {
        console.error('Firestore write failed:', e?.message || e);
        firestore = { updated: false, error: 'Firestore write failed' };
      }
    }

    return send(res, 200, {
      ok: true,
      summary: {
        packageName,
        productId,
        isActive,
        expiryTimeMillis,
        expiryIso: expiryTimeMillis ? new Date(expiryTimeMillis).toISOString() : null,
        autoRenewing: !!data.autoRenewing,
        acknowledged: acknowledgementState === 1,
      },
      firestore,
    });
  } catch (err) {
    console.error('verify-subscription error:', err?.message || err);
    return send(res, 500, {
      ok: false,
      error: 'Verification failed',
      details: String(err?.message || err),
      data,
    });
  }
}
