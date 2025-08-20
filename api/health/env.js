export default async function handler(req, res) {
  try {
    // Only reveal presence/length, never actual secrets
    const keys = [
      "GOOGLE_SA_JSON",
      "FIREBASE_SERVICE_ACCOUNT",
      "PAYSTACK_SECRET_KEY",
      "PLAY_PACKAGE_NAME"
    ];

    const envSummary = {};
    for (const k of keys) {
      const v = process.env[k];
      envSummary[k] = v ? `set (${v.length} chars)` : "missing";
    }

    return res.status(200).json({
      ok: true,
      node: process.version,
      routes: [
        "GET /api/health/env",
        "POST /api/iap/google",
        "POST /api/iap/verify",
        "POST /api/play/verify-subscription",
        "POST /api/tasks/expire"
      ],
      env: envSummary
    });
  } catch (e) {
    // Never leak errors; just return a generic message
    return res.status(500).send("health check failed");
  }
}
