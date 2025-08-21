// api/play/verify-subscription.js
import admin from 'firebase-admin';
import { google } from 'googleapis';

/** -----------------------
 *  Helpers
 *  ----------------------*/
function json(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function getEnv(name, fallback = undefined) {
  const v = process.env[name];
  return typeof v === 'string' && v.length ? v : fallback;
}

// Fix escaped newlines in env private keys
function fixKey(k) {
  return (k || '').replace(/\\n/g, '\n');
}

/** -----------------------
 *  Firebase Admin (singleton)
 *  ----------------------*/
function ensureAdmin() {
  if (!admin.apps.length) {
    const jsonStr = getEnv('GOOGLE_SA_JSON');
    if (jsonStr) {
      // Option A: Full service account JSON in a single env
      const creds = JSON.parse(jsonStr);
      admin.initializeApp({
        credential: admin.credential.cert(creds),
      });
    } else {
      // Option B: Split env vars
      const clientEmail =
        getEnv('FIREBASE_SA_CLIENT_EMAIL') ||
        getEnv('GOOGLE_SA_CLIENT_EMAIL') ||
        getEnv('SA_CLIENT_EMAIL');

      const privateKey =
        fixKey(getEnv('FIREBASE_SA_PRIVATE_KEY') ||
        getEnv('GOOGLE_SA_PRIVATE_KEY') ||
        getEnv('SA_PRIVATE_KEY'));

      const projectId =
        getEnv('FIREBASE_PROJECT_ID') ||
        getEnv('GOOGLE_SA_PROJECT_ID') ||
        getEnv('GCLOUD_PROJECT') ||
        undefined;

      if (!clientEmail || !privateKey) {
        throw new Error('Missing Firebase Admin credentials');
      }

      admin.initializeApp({
        credential: admin.credential.cert({
          clientEmail,
          privateKey,
          projectId,
        }),
      });
    }
  }
  return admin;
}

/** -----------------------
 *  Google Android Publisher (singleton)
 *  ----------------------*/
let publisherPromise = null;
function ensurePublisher() {
  if (!publisherPromise) {
    publisherPromise = (async () => {
      // Prefer dedicated Google Play service account envs if you use a different SA for Play
      const playClientEmail =
        getEnv('GOOGLE_PLAY_SA_CLIENT_EMAIL') ||
        getEnv('ANDROID_PUBLISHER_CLIENT_EMAIL') ||
        getEnv('GOOGLE_SA_CLIENT_EMAIL') ||
        getEnv('SA_CLIENT_EMAIL');

      const playPrivateKey = fixKey(
        getEnv('GOOGLE_PLAY_SA_PRIVATE_KEY') ||
        getEnv('ANDROID_PUBLISHER_PRIVATE_KEY') ||
        getEnv('GOOGLE_SA_PRIVATE_KEY') ||
        getEnv('SA_PRIVATE_KEY')
      );

      if (!playClientEmail || !playPrivateKey) {
        throw new Error('Missing Google Play service account credentials');
      }

      const jwt = new google.auth.JWT({
        email: playClientEmail,
        key: playPrivateKey,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });

      const androidpublisher = google.androidpublisher({
        version: 'v3',
        auth: jwt,
      });

      return androidpublisher;
    })();
  }
  return publisherPromise;
}

/** -----------------------
 *  Config
 *  ----------------------*/
const PLAY_PACKAGE_NAME = getEnv('PLAY_PACKAGE_NAME') || getEnv('GOOGLE_PLAY_PACKAGE_NAME');

// Add any additional SKUs you sell:
const ALLOWED_PRODUCTS = new Set([
  'lullibee_premium_monthly',
  // 'lullibee_premium_annual', ...
]);

/** -----------------------
 *  Request handler
 *  ----------------------*/
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return json(res, 400, { ok: false, error: 'Invalid JSON body' });
  }

  const {
    platform = 'android',
    packageName: bodyPackage,
    productId,
    purchaseToken,
    uid,
  } = body || {};

  // Validate basics
  if (platform !== 'android') {
    return json(res, 400, { ok: false, error: 'Only Android subscriptions are supported here' });
  }
  const packageName = bodyPackage || PLAY_PACKAGE_NAME;
  if (!packageName) {
    return json(res, 400, { ok: false, error: 'Missing packageName/PLAY_PACKAGE_NAME' });
  }
  if (!productId) {
    return json(res, 400, { ok: false, error: 'Missing productId' });
  }
  if (!ALLOWED_PRODUCTS.has(productId)) {
    return json(res, 400, { ok: false, error: `Unknown productId: ${productId}` });
  }
  if (!purchaseToken) {
    return json(res, 400, { ok: false, error: 'Missing purchaseToken' });
  }

  // If you want to enforce the exact package in prod:
  if (PLAY_PACKAGE_NAME && packageName !== PLAY_PACKAGE_NAME) {
    return json(res, 400, { ok: false, error: 'packageName does not match server configuration' });
  }

  let data = null;
  let isActive = false;
  let nowMs = Date.now();

  try {
    const adminApp = ensureAdmin();
    const publisher = await ensurePublisher();

    // Verify with Google Play
    const resp = await publisher.purchases.subscriptions.get({
      packageName,
      subscriptionId: productId,
      token: purchaseToken,
    });
    data = resp.data || {};

    // Google fields we care about:
    // - expiryTimeMillis (string number)
    // - acknowledgementState (0 = yet to acknowledge, 1 = acknowledged)
    // - purchaseState (0 = purchased)
    // - paymentState (optional: 1=Pending, 2=Received, 3=FreeTrial, etc)
    const expiryTimeMillis = Number(data.expiryTimeMillis || 0);
    const purchaseState = String(data.purchaseState ?? '');
    const acknowledgementState = Number(data.acknowledgementState ?? -1);

    // Active if future expiry and purchased
    isActive = expiryTimeMillis > nowMs && purchaseState === '0';

    // Always acknowledge when active & not acknowledged
    if (isActive && acknowledgementState === 0) {
      try {
        await publisher.purchases.subscriptions.acknowledge({
          packageName,
          subscriptionId: productId,
          token: purchaseToken,
          requestBody: { developerPayload: 'ack-by-server' },
        });
      } catch (ackErr) {
        // Non-fatal; log and continue
        console.warn('acknowledge failed:', ackErr?.message || ackErr);
      }
    }

    // If we have uid, write entitlement
    let firestore = { updated: false };
    if (!uid) {
      firestore.reason = 'No uid provided (skipped entitlement write)';
    } else {
      try {
        const userRef = adminApp.firestore().doc(`users/${uid}`);
        const premium = {
          active: !!isActive,
          expiryTimeMillis: expiryTimeMillis || 0,
        };

        const audit = {
          purchaseState: Number(data.purchaseState ?? -1),
          acknowledgementState,
          paymentState: Number(data.paymentState ?? -1),
          orderId: data.orderId || null,
          packageName,
          productId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await userRef.set(
          {
            premium,
            billing: {
              googlePlay: audit,
            },
          },
          { merge: true }
        );

        firestore = { updated: true };
      } catch (writeErr) {
        console.error('Firestore write failed:', writeErr?.message || writeErr);
        firestore = { updated: false, error: 'Firestore write failed' };
      }
    }

    // Respond
    return json(res, 200, {
      ok: true,
      summary: {
        productId,
        packageName,
        expiryTimeMillis,
        isActive,
        acknowledged: acknowledgementState === 1,
      },
      firestore,
    });
  } catch (err) {
    console.error('verify-subscription error:', err?.message || err);
    return json(res, 500, {
      ok: false,
      error: 'Verification failed',
      details: String(err?.message || err),
      data,
    });
  }
}
