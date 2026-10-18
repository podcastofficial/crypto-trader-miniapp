"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is missing");
    }

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    });
  }

  return pool;
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function verifyTelegramInitData(initData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token || typeof initData !== "string" || !initData) {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
      return null;
    }

    params.delete("hash");

    const entries = [...params.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    );

    const dataCheckString = entries
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(token)
      .digest();

    const expectedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest();

    const actualHash = Buffer.from(hash, "hex");

    if (
      actualHash.length !== expectedHash.length ||
      !crypto.timingSafeEqual(actualHash, expectedHash)
    ) {
      return null;
    }

    const authDate = Number(params.get("auth_date"));
    const now = Math.floor(Date.now() / 1000);

    if (
      !Number.isFinite(authDate) ||
      authDate > now + 30 ||
      now - authDate > 3600
    ) {
      return null;
    }

    const userJson = params.get("user");
    if (!userJson) return null;

    const user = JSON.parse(userJson);

    if (!user.id || !Number.isSafeInteger(Number(user.id))) {
      return null;
    }

    return user;
  } catch {
    return null;
  }
}

function parseAmount(value) {
  const text = String(value ?? "").trim();

  if (!/^\d{1,8}(\.\d{1,8})?$/.test(text)) {
    return null;
  }

  const amount = Number(text);

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return amount;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return sendJson(res, 405, {
      success: false,
      message: "Method not allowed."
    });
  }

  const body = req.body || {};
  const telegramUser = verifyTelegramInitData(body.initData);

  if (!telegramUser) {
    return sendJson(res, 401, {
      success: false,
      message: "Telegram authentication failed. Reopen the Mini App."
    });
  }

  const action = String(body.action || "");

  let client;

  try {
    const db = getPool();

    const userResult = await db.query(
      `SELECT id
       FROM public.users
       WHERE telegram_id = $1
       LIMIT 1`,
      [String(telegramUser.id)]
    );

    if (!userResult.rows.length) {
      return sendJson(res, 403, {
        success: false,
        message: "User not found. Open the main game first."
      });
    }

    const userId = userResult.rows[0].id;

    if (action === "history") {
      const history = await db.query(
        `SELECT id, transaction_type, amount, status,
                network, tx_hash, destination_address,
                admin_note, created_at, updated_at
         FROM public.real_wallet_ledger
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [userId]
      );

      const wallet = await db.query(
        `SELECT balance
         FROM public.real_wallet_balances
         WHERE user_id = $1`,
        [userId]
      );

      return sendJson(res, 200, {
        success: true,
        balance: wallet.rows[0]?.balance || "0",
        transactions: history.rows
      });
    }

    if (action === "deposit_request") {
      const amount = parseAmount(body.amount);

      if (amount === null || amount < 1 || amount > 10000) {
        return sendJson(res, 400, {
          success: false,
          message: "Deposit amount must be between 1 and 10000 USDT."
        });
      }

      return sendJson(res, 503, {
        success: false,
        message:
          "Automatic deposit requests are not enabled yet. Blockchain verification must be configured first."
      });
    }

    if (action === "withdraw_request") {
      const amount = parseAmount(body.amount);
      const address = String(body.address || "").trim();

      if (amount === null || amount < 1 || amount > 10000) {
        return sendJson(res, 400, {
          success: false,
          message: "Withdrawal amount must be between 1 and 10000 USDT."
        });
      }

      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return sendJson(res, 400, {
          success: false,
          message: "Enter a valid BEP-20 wallet address."
        });
      }

      return sendJson(res, 503, {
        success: false,
        message:
          "Withdrawals are disabled until balance reservation and secure admin approval are deployed."
      });
    }

    return sendJson(res, 400, {
      success: false,
      message: "Unknown wallet action."
    });
  } catch (error) {
    console.error(
      "Wallet API error:",
      error.code || error.name || "Error"
    );

    return sendJson(res, 500, {
      success: false,
      message: "Wallet service temporarily unavailable."
    });
  } finally {
    if (client) client.release();
  }
};