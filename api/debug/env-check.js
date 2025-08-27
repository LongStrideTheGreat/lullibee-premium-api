export const config = { runtime: "nodejs" };

function maskEmail(e) {
  if (!e) return null;
  const [u, d] = e.split("@");
  return (u?.slice(0,2) || "") + "***@" + (d || "");
}

export default async function handler(req, res) {
  const env = process.env;
  res.status(200).json({
    ok: true,
    FIREBASE_PROJECT_ID: !!env.FIREBASE_PROJECT_ID,
    SA_CLIENT_EMAIL: maskEmail(env.SA_CLIENT_EMAIL),
    SA_PRIVATE_KEY: !!env.SA_PRIVATE_KEY,
    GOOGLE_PLAY_SA_CLIENT_EMAIL: maskEmail(env.GOOGLE_PLAY_SA_CLIENT_EMAIL),
    GOOGLE_PLAY_SA_PRIVATE_KEY: !!env.GOOGLE_PLAY_SA_PRIVATE_KEY,
    GOOGLE_PLAY_PACKAGE_NAME: env.GOOGLE_PLAY_PACKAGE_NAME || null
  });
}
