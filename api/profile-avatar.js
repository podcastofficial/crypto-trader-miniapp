"use strict";
const pool = require("../lib/pgpool");
const { verifyTelegramInitData } = require("../lib/telegram-auth");
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ success:false, message:"Method not allowed." }); }
  const user = verifyTelegramInitData(req.body && req.body.initData);
  if (!user) return res.status(401).json({ success:false, message:"Telegram session invalid or expired. Reopen the Mini App." });
  const displayName = String(req.body && req.body.displayName || "").trim().slice(0,64);
  if (!displayName) return res.status(400).json({ success:false, message:"Enter a display name." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT id FROM public.users WHERE telegram_id=$1 LIMIT 1", [String(user.id)]);
    if (!found.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ success:false, message:"User not found. Reopen the Mini App and try again." }); }
    const userId = found.rows[0].id;
    await client.query(`CREATE TABLE IF NOT EXISTS public.user_profiles (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT UNIQUE NOT NULL, username TEXT, first_name TEXT, last_name TEXT,
      bio TEXT, avatar_url TEXT, wallet_address TEXT, country TEXT, language TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`INSERT INTO public.user_profiles(user_id,first_name,updated_at) VALUES($1,$2,NOW())
      ON CONFLICT(user_id) DO UPDATE SET first_name=EXCLUDED.first_name, updated_at=NOW()`, [userId, displayName]);
    await client.query("UPDATE public.users SET first_name=$1 WHERE id=$2", [displayName, userId]);
    await client.query("COMMIT");
    return res.status(200).json({ success:true, displayName });
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    console.error("Profile save failed:", e.code || e.message);
    return res.status(500).json({ success:false, message:"Could not save profile." });
  } finally { client.release(); }
};
