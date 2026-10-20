"use strict";

const { put } = require("@vercel/blob");
const pool = require("../lib/pgpool");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed." });
  const id = String(req.headers["x-telegram-id"] || req.headers["x-user-id"] || "").trim();
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = null; } }
  const file = body?.file;
  if (!id || !file) return res.status(400).json({ success: false, message: "Missing image." });
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(file)) return res.status(400).json({ success: false, message: "Use PNG, JPG, or WebP." });
  const base64 = file.split(",", 2)[1];
  if (!base64) return res.status(400).json({ success: false, message: "Invalid image data." });
  if (!base64 || Buffer.byteLength(base64, "base64") > 2 * 1024 * 1024) return res.status(400).json({ success: false, message: "Image must be under 2 MB." });
  try {
    const mime = file.slice(5, file.indexOf(";"));
    const blob = await put(`avatars/${id}-${Date.now()}.${mime.split("/")[1]}`, Buffer.from(base64, "base64"), { access: "public", contentType: mime });
    const client = await pool.connect();
    try {
      await client.query("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url TEXT");
      await client.query("UPDATE public.users SET avatar_url = $1 WHERE telegram_id = $2", [blob.url, id]);
    } finally { client.release(); }
    return res.status(200).json({ success: true, url: blob.url });
  } catch (error) {
    console.error("profile avatar error:", error.stack || error.message);
    return res.status(500).json({ success: false, message: "Could not upload image: " + (error.message || "storage error") });
  }
};
