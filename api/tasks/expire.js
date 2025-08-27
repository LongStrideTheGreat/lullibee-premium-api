export const config = { runtime: "nodejs" };

import admin from "firebase-admin";

function getAdmin() {
  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID || "";
    const clientEmail = process.env.SA_CLIENT_EMAIL || "";
    let privateKey = process.env.SA_PRIVATE_KEY || "";
    if (privateKey.includes("\\n")) privateKey = privateKey.replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error("Firebase Admin env missing (FIREBASE_PROJECT_ID / SA_CLIENT_EMAIL / SA_PRIVATE_KEY)");
    }

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

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Allow either Vercel Cron or your custom secret
  const fromVercelCron = req.headers["x-vercel-cron"] === "1";
  const customOk = (req.headers["x-cron-secret"] || "") === process.env.CRON_SECRET;
  if (!fromVercelCron && !customOk) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const adminSdk = getAdmin();
    const db = adminSdk.firestore();
    const now = Date.now();

    const snap = await db
      .collection("users")
      .where("premium.active", "==", true)
      .where("premium.expiryTimeMillis", "<", now)
      .get();

    if (snap.empty) return res.status(200).json({ ok: true, processed: 0 });

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

    await batch.commit();
    return res.status(200).json({ ok: true, processed: snap.size });
  } catch (err) {
    console.error("[expire] 500:", err?.message || String(err));
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
