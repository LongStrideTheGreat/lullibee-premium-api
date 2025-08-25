// api/tasks/expire.js
import { getAdmin } from '../_admin.js';

export default async function handler(req, res) {
  // Optional: protect endpoint (unchanged)
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

    // Helper to read millis from either number or Timestamp
    const toMillis = (v) =>
      v && typeof v.toMillis === 'function' ? v.toMillis() : (Number(v) || 0);

    // Run a paginated expiry sweep for a specific field path
    // fieldPath: 'premium.expiresAt' or 'premium.expiryTimeMillis'
    async function sweep(fieldPath) {
      let last = null;

      // We filter users who still have premium.active === true and are expired by fieldPath
      // NOTE: Requires a composite index: where(premium.active==true), where(fieldPath<=), orderBy(fieldPath)
      while (true) {
        let q = db
          .collection('users')
          .where('premium.active', '==', true)
          .where(fieldPath, '<=', nowMs)
          .orderBy(fieldPath, 'asc')
          .limit(pageSize);

        if (last) q = q.startAfter(last);

        const snap = await q.get();
        if (snap.empty) break;

        const batch = db.batch();
        let writes = 0;

        for (const docSnap of snap.docs) {
          const d = docSnap.data() || {};
          // Compute the "best known" expiry in ms across both fields
          const expMs = Math.max(
            toMillis(d?.premium?.expiresAt),
            toMillis(d?.premium?.expiryTimeMillis),
            Number(d?.premiumExpiry) || 0 // legacy support
          );

          if (expMs > 0 && expMs <= nowMs) {
            const update = {
              premium: {
                ...(d.premium || {}),
                active: false,
                // keep stored expiry values as-is for audit; do not erase them
              },
              premiumExpiry: 0, // legacy field for older clients
              lastDowngradedAt: FieldValue.serverTimestamp(),
            };

            // Maintain legacy plan flow only if it was set to 'premium'
            if (d.plan === 'premium') {
              update.plan = 'free';
            }

            batch.set(docSnap.ref, update, { merge: true });
            writes += 1;
          }
        }

        if (writes) {
          await batch.commit();
          totalDowngrades += writes;
        }

        processed += snap.size;
        last = snap.docs[snap.docs.length - 1];
      }
    }

    // Sweep by both fields to emulate OR (users might have one or the other)
    await sweep('premium.expiresAt');
    await sweep('premium.expiryTimeMillis');

    // Optional: final sweep for very old schema (plan/premiumExpiry) — safe to remove later
    try {
      let lastLegacy = null;
      while (true) {
        let q = db
          .collection('users')
          .where('plan', '==', 'premium')
          .where('premiumExpiry', '<=', nowMs)
          .orderBy('premiumExpiry', 'asc')
          .limit(pageSize);

        if (lastLegacy) q = q.startAfter(lastLegacy);
        const snap = await q.get();
        if (snap.empty) break;

        const batch = db.batch();
        let writes = 0;

        for (const docSnap of snap.docs) {
          const d = docSnap.data() || {};
          const exp = Number(d.premiumExpiry) || 0;
          if (exp > 0 && exp <= nowMs) {
            batch.set(
              docSnap.ref,
              {
                plan: 'free',
                premiumExpiry: 0,
                premium: { ...(d.premium || {}), active: false },
                lastDowngradedAt: FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            writes += 1;
          }
        }

        if (writes) {
          await batch.commit();
          totalDowngrades += writes;
        }

        processed += snap.size;
        lastLegacy = snap.docs[snap.docs.length - 1];
      }
    } catch (e) {
      // ignore legacy errors; schema may not exist
    }

    return res.status(200).json({ ok: true, processed, downgrades: totalDowngrades });
  } catch (e) {
    console.error('expire task error:', e);
    return res.status(200).json({ ok: false, error: 'internal' });
  }
}
