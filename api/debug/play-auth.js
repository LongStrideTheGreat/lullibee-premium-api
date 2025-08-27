module.exports.config = { runtime: "nodejs" };
const { google } = require("googleapis");

module.exports = async (req, res) => {
  try {
    const email = process.env.GOOGLE_PLAY_SA_CLIENT_EMAIL || "";
    let key = process.env.GOOGLE_PLAY_SA_PRIVATE_KEY || "";
    if (key.includes("\\n")) key = key.replace(/\\n/g, "\n");
    if (!email || !key) throw new Error("Missing Play SA env");

    const jwt = new google.auth.JWT({
      email, key, scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
    await jwt.authorize(); // <-- proves auth works

    res.status(200).json({ ok: true, message: "Play auth OK" });
  } catch (e) {
    res.status(200).json({ ok: false, where: "play-auth", details: String(e?.message || e) });
  }
};
