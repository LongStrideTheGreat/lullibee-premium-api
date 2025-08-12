// api/_admin.js
import admin from "firebase-admin";

export function getAdmin() {
  if (!admin.apps.length) {
    const {
      FIREBASE_PROJECT_ID,
      SA_CLIENT_EMAIL,
      SA_PRIVATE_KEY
    } = process.env;

    if (!FIREBASE_PROJECT_ID || !SA_CLIENT_EMAIL || !SA_PRIVATE_KEY) {
      throw new Error("Missing Firebase admin env vars");
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: SA_CLIENT_EMAIL,
        // Vercel env often stores newlines escaped; replace them:
        privateKey: SA_PRIVATE_KEY.replace(/\\n/g, "\n")
      })
    });
  }
  return admin;
}
