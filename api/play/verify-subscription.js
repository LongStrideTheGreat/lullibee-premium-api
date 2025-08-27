// /api/play/verify-subscription.js
// Vercel Node.js Serverless Function (Node 18+)

const { google } = require('googleapis');
const admin = require('firebase-admin');

// --- init Firebase Admin once per lambda instance ---
function getAdmin() {
  if (!admin.apps.length) {
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
  }
  return admin;
}

// --- Play Developer client (uses JWT with normalized private key) ---
async function getAndroidPublisher() {
  const email = process.env.GOOGLE_PLAY_SA_CLIENT_EMAIL || '';
  let key = process.env.GOOGLE_PLAY_SA_PRIVATE_KEY || '';
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');

  const jwt = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  return google.androidpublisher({ version: 'v3', auth: jwt });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Plumbing check without hitting Google/Firestore
  if (req.headers['x-test-mode'] === 'true') {
    return res.status(200).json({ ok: true, test: true, saw: req.body || {} });
  }

  const {
    platform = 'android',
    packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME,
    productId,
    purchaseToken,
    uid, // Firebase UID (required to write entitlement)
  } = req.body || {};

  if (platform !== 'android') return res.status(400).json({ ok: false, error: 'Only Android supported here' });
  if (!uid) return res.status(400).json({ ok: false, error: 'Missing uid' });
  if (!packageName) return res.status(400).json({ ok: false, error: 'Missing packageName' });
  if (!purchaseToken) return res.status(400).json({ ok: false, error: 'Missing purchaseToken' });

  // Optional allowlist for SKUs
  const allowedPrefix = process.env.ALLOWED_SKU_PREFIX;
  if (allowedPrefix && productId && !String(productId).startsWith(allowedPrefix)) {
    return res.status(400).json({ ok: false, error: 'SKU not allowed' });
  }

  try {
    const androidpublisher = await getAndroidPublisher();

    // Subscriptions v2 API (preferred)
    const subRes = await androidpublisher.purchases.subscriptionsv2.get({
      packageName,
      token: purchaseToken,
    });

    const data = subRes.data || {};
    const line = Array.isArray(data.lineItems) ? data.lineItems[0] : null;
    const expiryMs = Number(line?.expiryTime || 0);
    const active = Number.isFinite(expiryMs) && expiryMs > Date.now();

    // Best-effort legacy acknowledge (no-op if already acked)
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

    // Write entitlement to Firestore
    const adminSdk = getAdmin();
    const db = adminSdk.firestore();

    await db.collection('users').doc(uid).set(
      {
        premium: {
          active,
          source: 'play',
          updatedAt: adminSdk.firestore.FieldValue.serverTimestamp(),
          expiresAt: expiryMs ? adminSdk.firestore.Timestamp.fromMillis(expiryMs) : null,
          expiryTimeMillis: expiryMs || null,
          sku: productId || null,
        },
      },
      { merge: true }
    );

    return res.status(200).json({
      ok: true,
      summary: {
        isActive: active,
        expiryTimeMillis: expiryMs || null,
      },
    });
  } catch (err) {
    // This is where you previously saw "DECODER routines::unsupported" under Edge
    return res.status(500).json({
      ok: false,
      error: 'Verification failed',
      details: { message: err?.message || String(err) },
    });
  }
};
