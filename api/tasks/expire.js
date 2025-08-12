// api/tasks/expire.js
import { getAdmin } from "../_admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const admin = getAdmin();
    const db = admin.firestore();

    const now = Date.now();
    const snap = await db
      .collection("users")
      .where("plan", "==", "premium")
      .where("premiumExpiry", "<=", now)
      .get();

    if (snap.empty) return res.json({ ok: true, count: 0 });

    const batch = db.batch();
    snap.forEach((doc) => batch.update(doc.ref, { plan: "free" }));
    await batch.commit();

    return res.json({ ok: true, count: snap.size });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
}
