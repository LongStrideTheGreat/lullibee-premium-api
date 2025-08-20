// /api/iap/verify.js
export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { purchaseToken, productId, packageName } = req.body;

  if (!purchaseToken || !productId || !packageName) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // For now, just echo back the data.
  // Later, we’ll connect this to Google Play API verification.
  return res.status(200).json({
    message: "Verification endpoint working!",
    received: { purchaseToken, productId, packageName },
  });
}
