"use strict";
const pool = require("../lib/pgpool");
const { ethers } = require("ethers");

const TOKEN_ADDRESS = (
  process.env.USDT_BEP20_TOKEN_ADDRESS || "0x55d398326f99059fF775485246999027B3197955"
).toLowerCase();

function getTelegramIdFromRequest(req) {
  const header = req.headers["x-telegram-id"];
  if (header) return String(header);

  const uid = req.headers["x-user-id"];
  return uid ? String(uid) : null;
}

async function resolveUserId(client, telegramId) {
  const result = await client.query(
    `SELECT id FROM public.users WHERE telegram_id = $1 LIMIT 1`,
    [telegramId]
  );

  if (result.rows[0]) return Number(result.rows[0].id);
  return Number(telegramId);
}

async function getHumanBalance(client, userId) {
  // real_wallet_balances stores human decimal string, not raw
  const result = await client.query(
    `SELECT balance
     FROM public.real_wallet_balances
     WHERE user_id = $1
       AND token_address = $2
     LIMIT 1`,
    [userId, TOKEN_ADDRESS]
  );

  return result.rows[0]?.balance || "0";
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }

  const telegramId = getTelegramIdFromRequest(req);
  if (!telegramId) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }

  const { toAddress, amount } = req.body || {};
  if (!toAddress || !amount) {
    return res.status(400).json({ success: false, message: "Missing toAddress or amount." });
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(String(toAddress))) {
    return res.status(400).json({ success: false, message: "Invalid toAddress." });
  }

  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ success: false, message: "Invalid amount." });
  }

  let client;
  try {
    client = await pool.connect();
    const userId = await resolveUserId(client, telegramId);

    const balanceStr = await getHumanBalance(client, userId);

    const required = ethers.utils.parseUnits(String(amountNum), 18).toString();

    // convert human balance to raw for comparison
    let currentRaw;
    try {
      currentRaw = BigInt(ethers.utils.parseUnits(String(balanceStr), 18).toString());
    } catch {
      currentRaw = BigInt(balanceStr || "0");
    }

    const requiredBig = BigInt(required);
    if (currentRaw < requiredBig) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance."
      });
    }

    const updatedBalanceRaw = (currentRaw - requiredBig).toString();
    const updatedBalanceHuman = ethers.utils.formatUnits(updatedBalanceRaw, 18);

    await client.query("BEGIN");

    const ledgerInsert = await client.query(
      `INSERT INTO public.real_wallet_ledger
         (user_id, transaction_type, amount, status, network, destination_address, created_at, updated_at)
       VALUES ($1, 'withdraw', $2, 'pending', 'BEP20', $3, NOW(), NOW())
       RETURNING id`,
      [userId, String(amountNum), String(toAddress)]
    );

    await client.query(
      `INSERT INTO public.real_wallet_balances (user_id, token_address, balance, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, token_address)
       DO UPDATE SET balance = EXCLUDED.balance, updated_at = NOW()`,
      [userId, TOKEN_ADDRESS, updatedBalanceHuman]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Withdrawal request created and balance reserved.",
      withdrawId: ledgerInsert.rows[0].id,
      status: "pending"
    });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    console.error("withdraw-request error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not create withdrawal request."
    });
  } finally {
    if (client) client.release();
  }
};