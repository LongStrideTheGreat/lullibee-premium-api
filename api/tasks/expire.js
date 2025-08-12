// api/tasks/expire.js
// Downgrades users when premiumExpiry <= now.
// Safe to run frequently; idempotent; batched writes.

import { getAdmin } from '../_admin.js';

export default async function handler(req, res) {
  // Optional: protect the endpoint (recommended)
  const okSecret =
    process.env.CRON_SECRET &&
    (req.headers['x-cron-secret'] === process.env.CRON_SECRET ||
     req.query?.secret === process.env.CRON_SECRET);

  if (process.env.CRON_SECRET && !okSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const admin = getAdmin();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    const nowMs = Date.now();
    const pageSize = 300; // keep batches reasonable
    let processed = 0;
    let totalDowngrades = 0;

    // We page through results to handle > pageSize users
    let last;
    do {
      // Requires composite index:
      // users: plan ASC, premiumExpiry ASC
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
      let writesInThisBatch = 0;

      snap.docs.forEach((docSnap) => {
        const data = docSnap.data() || {};
        const expiry = Number(data.premiumExpiry);

        // Guard: only downgrade when expiry is a valid finite number in the past
        if (Number.isFinite(expiry) && expiry > 0 && expiry <= nowMs && data.plan === 'premium') {
          batch.set(
            docSnap.ref,
            {
              plan: 'free',
              lastDowngradedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          writesInThisBatch += 1;
        }
      });

      if (writesInThisBatch > 0) {
        await batch.commit();
        totalDowngrades += writesInThisBatch;
      }

      processed += snap.size;
      last = snap.docs[snap.docs.length - 1];
    } while (last);

    // Optional: light metric
    await db.collection('webhook_traces').add({
      ts: admin.firestore.FieldValue.serverTimestamp(),
      event: 'cron.expire',
      okSignature: true,
      mode: process.env.PAYSTACK_SECRET?.startsWith('sk_test_') ? 'test' : 'live',
      summary: { processed, downgrades: totalDowngrades, at: nowMs },
    });

    return res.status(200).json({ ok: true, processed, downgrades: totalDowngrades });
  } catch (err) {
    console.error('expire task error:', err);
    return res.status(200).json({ ok: false, error: 'internal' });
  }
}
