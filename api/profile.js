"use strict";

const pool = require("../lib/pgpool");

function telegramId(req) {
  const value = req.headers["x-telegram-id"] || req.headers["x-user-id"];
  return value ? String(value).trim() : null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }

  const id = telegramId(req);
  const displayName = String(req.body?.displayName || "").trim();
  if (!id) return res.status(401).json({ success: false, message: "Unauthorized." });
  if (displayName.length < 1 || displayName.length > 64) {
    return res.status(400).json({ success: false, message: "Enter a valid display name." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS display_name TEXT");
    const result = await client.query(
      `UPDATE public.users SET display_name = $1 WHERE telegram_id = $2 RETURNING display_name`,
      [displayName, id]
    );
    if (!result.rowCount) return res.status(404).json({ success: false, message: "User not found." });
    return res.status(200).json({ success: true, displayName: result.rows[0].display_name });
  } catch (error) {
    console.error("profile API error:", error.message);
    return res.status(500).json({ success: false, message: "Could not save profile." });
  } finally {
    if (client) client.release();
  }
};
