// api/tasks/expire.js
import { getAdmin } from '../_admin.js';

export default async function handler(req, res) {
  // Optional: protect endpoint
  const needSecret = Boolean(process.env.CRON_SECRET);
  const valid =
    !needSecret ||
    req.headers['x-cron-secret'] === process.env.CRON_SECRET ||
    req.query?.secret === process.env.CRON_SECRET;

  if (!valid) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const admin = getAdmin();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    const nowMs = Date.now();
    const pageSize = 300;
    let processed = 0;
    let totalDowngrades = 0;
    let last;

    do {
      let q = db
        .collection('users')
        .where('plan', '==', 'premium')
        .where('premiumExpiry', '<=', nowMs)
        .orderBy('premiumExpiry', 'asc')
        .limit(pageSize);

      if (last) q = q.startAfter(last);

      const snap = await q.get();
      if (snap.empty) break;

      const batch = db.batch();
      let writes = 0;

      snap.docs.forEach((docSnap) => {
        const d = docSnap.data() || {};
        const exp = Number(d.premiumExpiry);
        if (Number.isFinite(exp) && exp > 0 && exp <= nowMs) {
          batch.set(
            docSnap.ref,
            { plan: 'free', premiumExpiry: 0, lastDowngradedAt: FieldValue.serverTimestamp() },
            { merge: true }
          );
          writes += 1;
        }
      });

      if (writes) {
        await batch.commit();
        totalDowngrades += writes;
      }

      processed += snap.size;
      last = snap.docs[snap.docs.length - 1];
    } while (last);

    return res.status(200).json({ ok: true, processed, downgrades: totalDowngrades });
  } catch (e) {
    console.error('expire task error:', e);
    return res.status(200).json({ ok: false, error: 'internal' });
  }
}
