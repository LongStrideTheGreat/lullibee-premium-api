export default async function handler(req, res) {
  try {
    const keys = [
      "GOOGLE_SA_JSON",
      "PLAY_PACKAGE_NAME",
      "EXPO_PUBLIC_PREMIUM_API",
      "FIREBASE_PROJECT_ID",
    ];

    const envSummary = {};
    for (const k of keys) {
      const v = process.env[k];
      envSummary[k] = v ? `set (${v.length} chars)` : "missing";
    }

    res.status(200).json({
      ok: true,
      node: process.version,
      env: envSummary,
    });
  } catch (e) {
    res.status(500).send("health check failed");
  }
}
