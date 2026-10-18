"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

function response(res, status, data) {
  return res.status(status).json(data);
}

function verifyTelegramInitData(initData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token || !initData || typeof initData !== "string") {
    return null;
  }

  if (initData.length > 10000) return null;

  let params;

  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userText = params.get("user");

  if (
    !receivedHash ||
    !/^[a-f0-9]{64}$/i.test(receivedHash) ||
    !Number.isFinite(authDate) ||
    !userText
  ) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  if (authDate > now + 30 || now - authDate > 3600) {
    return null;
  }

  let telegramUser;

  try {
    telegramUser = JSON.parse(userText);
  } catch {
    return null;
  }

  if (
    !telegramUser ||
    !Number.isSafeInteger(Number(telegramUser.id)) ||
    Number(telegramUser.id) <= 0
  ) {
    return null;
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(token)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest();

  const receivedBuffer = Buffer.from(receivedHash, "hex");

  if (
    receivedBuffer.length !== calculatedHash.length ||
    !crypto.timingSafeEqual(calculatedHash, receivedBuffer)
  ) {
    return null;
  }

  return telegramUser;
}

function validAmount(value) {
  const str = String(value ?? "");

  if (!/^\d{1,5}(\.\d{1,8})?$/.test(str)) {
    return false;
  }

  const amount = Number(str);

  return Number.isFinite(amount) && amount >= 1 && amount <= 10000;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return response(res, 405, {
      success: false,
      message: "Method not allowed.",
    });
  }

  const body =
    req.body && typeof req.body === "object" ? req.body : {};

  const telegramUser = verifyTelegramInitData(body.initData);

  if (!telegramUser) {
    return response(res, 401, {
      success: false,
      message: "Telegram authentication failed. Reopen the Mini App.",
    });
  }

  const action = String(body.action || "");
  const telegramId = String(telegramUser.id);

  let client;

  try {
    client = await pool.connect();

    const userResult = await client.query(
      `SELECT id, telegram_id
       FROM public.users
       WHERE telegram_id = $1
       LIMIT 1`,
      [telegramId]
    );

    if (userResult.rowCount !== 1) {
      return response(res, 404, {
        success: false,
        message: "User not found. Authenticate through the main app first.",
      });
    }

    const userId = userResult.rows[0].id;

    if (action === "history") {
      const balanceResult = await client.query(
        `SELECT balance
         FROM public.real_wallet_balances
         WHERE user_id = $1`,
        [userId]
      );

      const historyResult = await client.query(
        `SELECT id, transaction_type, amount, status,
                network, tx_hash, destination_address,
                admin_note, created_at, updated_at,
                reviewed_at
         FROM public.real_wallet_ledger
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [userId]
      );

      return response(res, 200, {
        success: true,
        balance: balanceResult.rows[0]?.balance || "0",
        transactions: historyResult.rows,
      });
    }

    if (action === "deposit_request") {
      if (!validAmount(body.amount)) {
        return response(res, 400, {
          success: false,
          message: "Enter a valid deposit amount between 1 and 10000 USDT.",
        });
      }

      return response(res, 503, {
        success: false,
        message:
          "Deposit requests are temporarily disabled until unique deposit matching and blockchain verification are deployed.",
      });
    }

    if (action === "withdraw_request") {
      if (!validAmount(body.amount)) {
        return response(res, 400, {
          success: false,
          message: "Enter a valid withdrawal amount between 1 and 10000 USDT.",
        });
      }

      const address = String(body.address || "");

      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return response(res, 400, {
          success: false,
          message: "Enter a valid BEP-20 wallet address.",
        });
      }

      return response(res, 503, {
        success: false,
        message:
          "Withdrawals are disabled until atomic balance reservation and secure admin review are implemented.",
      });
    }

    return response(res, 400, {
      success: false,
      message: "Unknown wallet action.",
    });
  } catch (error) {
    console.error("Wallet API error:", error.message);

    return response(res, 500, {
      success: false,
      message: "Wallet service temporarily unavailable.",
    });
  } finally {
    if (client) client.release();
  }
};