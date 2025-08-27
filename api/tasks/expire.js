// /api/expire.js
// Vercel Node.js Serverless Function (Node 18+)

const admin = require('firebase-admin');

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const secret = req.headers['x-cron-secret'] || '';
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const adminSdk = getAdmin();
    const db = adminSdk.firestore();
    const now = Date.now();

    const snap = await db
      .collection('users')
      .where('premium.active', '==', true)
      .where('premium.expiryTimeMillis', '<', now)
      .get();

    const batch = db.batch();
    snap.forEach((doc) => {
      batch.set(
        doc.ref,
        {
          premium: {
            active: false,
            updatedAt: adminSdk.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );
    });

    if (!snap.empty) await batch.commit();
    return res.status(200).json({ ok: true, processed: snap.size });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
};
