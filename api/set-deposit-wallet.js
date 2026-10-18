"use strict";
const pool = require("../lib/pgpool");

function getTelegramIdFromRequest(req) {
  const header = req.headers["x-telegram-id"];
  if (header) return String(header);

  // Fallback for dev/testing: allow header-based user id
  const uid = req.headers["x-user-id"];
  return uid ? String(uid) : null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }

  const userId = getTelegramIdFromRequest(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }

  const walletAddress = (req.body && req.body.walletAddress) ? String(req.body.walletAddress).trim() : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ success: false, message: "Invalid wallet address." });
  }

  let client;
  try {
    client = await pool.connect();

    // Prefer public.users.telegram_id mapping if the repo has that table
    const userLookup = await client.query(
      `SELECT id
       FROM public.users
       WHERE telegram_id = $1
       LIMIT 1`,
      [userId]
    );

    const finalUserId = userLookup.rows[0] ? Number(userLookup.rows[0].id) : Number(userId);

    await client.query(
      `INSERT INTO user_wallets (user_id, wallet_address)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET wallet_address = EXCLUDED.wallet_address`,
      [finalUserId, walletAddress.toLowerCase()]
    );

    return res.status(200).json({
      success: true,
      walletAddress: walletAddress.toLowerCase()
    });
  } catch (err) {
    console.error("set-deposit-wallet error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not save wallet address."
    });
  } finally {
    if (client) client.release();
  }
};