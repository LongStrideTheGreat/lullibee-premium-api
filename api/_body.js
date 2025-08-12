// api/_body.js
// Helpers to read request body in Vercel serverless functions.

export async function readJson(req) {
  const buf = await readRaw(req);
  if (!buf || !buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); }
  catch { return {}; }
}

export function readRaw(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
