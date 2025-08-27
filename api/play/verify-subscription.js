// /api/play/verify-subscription.js
// Vercel serverless function — Node 18+
// Reads secrets from env (never hard-code secrets in source).

export const config = { runtime: 'edge' };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function getAndroidPublisher() {
  const { google } = await import('googleapis');

  const email = process.env.GOOGLE_PLAY_SA_CLIENT_EMAIL || '';
  let key = process.env.GOOGLE_PLAY_SA_PRIVATE_KEY || '';
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n'); // normalize key

  const jwt = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  return google.androidpublisher({ version: 'v3', auth: jwt });
}

let adminAppPromise = null;
async function getAdmin() {
  if (adminAppPromise) return adminAppPromise;
  adminAppPromise = (async () => {
    const admin = (await import('firebase-admin')).default;
    if (admin.apps.length) return admin;

    const projectId = process.env.FIREBASE_PROJECT_ID || '';
    const clientEmail = process.env.SA_CLIENT_EMAIL || '';
    let privateKey = process.env.SA_PRIVATE_KEY || '';
    if (privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');

    admin.initializeApp({
      credential: admin.credential.cert({
        project_id: projectId,
        client_email: clientEmail,
        private_key: privateKey,
      }),
    });
    return admin;
  })();
  return adminAppPromise;
}

async function parseBody(req) {
  try { return await req.json(); } catch { return {}; }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed' });
  }

  // plumbing check without hitting Google/Firestore
  if (req.headers.get('x-test-mode') === 'true') {
    const body = await parseBody(req);
    return jsonResponse(200, { ok: true, test: true, saw: body });
  }

  const body = await parseBody(req);
  const {
    platform = 'android',
    packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME, // <- uses your env
    productId,
    purchaseToken,
    uid, // Firebase UID to write entitlement for
  } = body || {};

  if (platform !== 'android') return jsonResponse(400, { ok: false, error: 'Only Android supported here' });
  if (!uid) return jsonResponse(400, { ok: false, error: 'Missing uid' });
  if (!packageName) return jsonResponse(400, { ok: false, error: 'Missing packageName' });
  if (!purchaseToken) return jsonResponse(400, { ok: false, error: 'Missing purchaseToken' });

  const allowedPrefix = process.env.ALLOWED_SKU_PREFIX;
  if (allowedPrefix && productId && !String(productId).startsWith(allowedPrefix)) {
    return jsonResponse(400, { ok: false, error: 'SKU not allowed' });
  }

  try {
    const androidpublisher = await getAndroidPublisher();

    // Subscriptions v2: returns entitlement lines with expiry
    const subRes = await androidpublisher.purchases.subscriptionsv2.get({
      packageName,
      token: purchaseToken,
    });

    const data = subRes.data || {};
    const line = Array.isArray(data.lineItems) ? data.lineItems[0] : null;
    const expiryMs = Number(line?.expiryTime || 0);
    const active = Number.isFinite(expiryMs) && expiryMs > Date.now();

    // Legacy acknowledge (best-effort; some tracks still require explicit ack)
    if (active && productId) {
      try {
        await androidpublisher.purchases.subscriptions.acknowledge({
          packageName,
          subscriptionId: productId,
          token: purchaseToken,
          requestBody: {},
        });
      } catch (ackErr) {
        console.log('acknowledge warning:', ackErr?.message || String(ackErr));
      }
    }

    // Write entitlement in Firestore
    const admin = await getAdmin();
    const db = admin.firestore();

    await db.collection('users').doc(uid).set({
      premium: {
        active,
        source: 'play',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: expiryMs ? admin.firestore.Timestamp.fromMillis(expiryMs) : null,
        expiryTimeMillis: expiryMs || null,
        sku: productId || null,
      },
    }, { merge: true });

    return jsonResponse(200, { ok: true, summary: { isActive: active, expiryTimeMillis: expiryMs || null } });
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: 'Verification failed',
      details: { message: err?.message || String(err) },
    });
  }
}
