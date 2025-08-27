// /api/expire.js
export const config = { runtime: 'edge' };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

export default async function handler(req) {
  if (req.method !== 'POST') return jsonResponse(405, { ok: false, error: 'Method not allowed' });

  const secret = req.headers.get('x-cron-secret') || '';
  if (!secret || secret !== process.env.CRON_SECRET) {
    return jsonResponse(401, { ok: false, error: 'Unauthorized' });
  }

  try {
    const admin = await getAdmin();
    const db = admin.firestore();

    const now = Date.now();
    const snap = await db.collection('users')
      .where('premium.expiryTimeMillis', '<', now)
      .where('premium.active', '==', true)
      .get();

    const batch = db.batch();
    snap.forEach((doc) => {
      batch.set(doc.ref, {
        premium: {
          active: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      }, { merge: true });
    });

    if (!snap.empty) await batch.commit();
    return jsonResponse(200, { ok: true, processed: snap.size });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err?.message || String(err) });
  }
}
