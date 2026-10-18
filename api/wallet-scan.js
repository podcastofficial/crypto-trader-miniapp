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

function send(res, status, data) {
  return res.status(status).json(data);
}

function verifyTelegramInitData(initData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token || typeof initData !== "string" || !initData) {
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
    !Number.isSafeInteger(authDate) ||
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

function validBep20Address(address) {
  return typeof address === "string" &&
    /^0x[a-fA-F0-9]{40}$/.test(address);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return send(res, 405, {
      success: false,
      message: "Method not allowed.",
    });
  }

  const body =
    req.body && typeof req.body === "object" ? req.body : {};

  const telegramUser = verifyTelegramInitData(body.initData);

  if (!telegramUser) {
    return send(res, 401, {
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
      return send(res, 404, {
        success: false,
        message: "User not found. Authenticate through the main app first.",
      });
    }

    const userId = userResult.rows[0].id;

    // WALLET HISTORY
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

      return send(res, 200, {
        success: true,
        balance: balanceResult.rows[0]?.balance || "0",
        transactions: historyResult.rows,
      });
    }

    // CREATE DEPOSIT REQUEST
    if (action === "deposit_request") {
      if (!validAmount(body.amount)) {
        return send(res, 400, {
          success: false,
          message: "Enter an amount between 1 and 10000 USDT.",
        });
      }

      const depositAddress =
        process.env.USDT_BEP20_DEPOSIT_ADDRESS;

      if (!validBep20Address(depositAddress)) {
        return send(res, 503, {
          success: false,
          message: "Deposit address is not configured correctly.",
        });
      }

      await client.query("BEGIN");

      try {
        // Lock this user's active deposit requests to reduce races.
        await client.query(
          `SELECT pg_advisory_xact_lock($1::bigint)`,
          [String(userId)]
        );

        const existing = await client.query(
          `SELECT id, amount, status, network,
                  destination_address, request_expires_at
           FROM public.real_wallet_ledger
           WHERE user_id = $1
             AND transaction_type = 'deposit'
             AND status = 'pending'
             AND request_expires_at > NOW()
           ORDER BY created_at DESC
           LIMIT 1`,
          [userId]
        );

        if (existing.rowCount > 0) {
          await client.query("COMMIT");

          return send(res, 200, {
            success: true,
            message: "You already have an active deposit request.",
            deposit: existing.rows[0],
          });
        }

        const baseAmount = Number(body.amount);

        // Unique 4-decimal request amount.
        // Blockchain scanner must match this exact amount.
        const suffix = crypto.randomInt(1, 9999) / 10000;
        const uniqueAmount = (baseAmount + suffix).toFixed(4);

        // Prevent a collision with another active deposit request.
        const collision = await client.query(
          `SELECT id
           FROM public.real_wallet_ledger
           WHERE transaction_type = 'deposit'
             AND status = 'pending'
             AND request_expires_at > NOW()
             AND amount = $1
           LIMIT 1`,
          [uniqueAmount]
        );

        if (collision.rowCount > 0) {
          await client.query("ROLLBACK");

          return send(res, 409, {
            success: false,
            message:
              "A matching deposit amount is already reserved. Please try again.",
          });
        }

        const result = await client.query(
          `INSERT INTO public.real_wallet_ledger
             (user_id, transaction_type, amount, status,
              network, destination_address, request_expires_at)
           VALUES
             ($1, 'deposit', $2, 'pending',
              'BEP20', $3, NOW() + INTERVAL '30 minutes')
           RETURNING id, amount, status, network,
                     destination_address, request_expires_at`,
          [userId, uniqueAmount, depositAddress]
        );

        await client.query("COMMIT");

        return send(res, 201, {
          success: true,
          message:
            "Deposit request created. Automatic crediting is not enabled yet.",
          deposit: result.rows[0],
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    // WITHDRAWALS REMAIN DISABLED UNTIL SAFE RESERVATION
    // AND AUTHENTICATED ADMIN REVIEW ARE IMPLEMENTED.
    if (action === "withdraw_request") {
      if (!validAmount(body.amount)) {
        return send(res, 400, {
          success: false,
          message: "Enter an amount between 1 and 10000 USDT.",
        });
      }

      if (!validBep20Address(body.address)) {
        return send(res, 400, {
          success: false,
          message: "Enter a valid BEP-20 wallet address.",
        });
      }

      return send(res, 503, {
        success: false,
        message:
          "Withdrawals are disabled until balance reservation and secure admin approval are implemented.",
      });
    }

    return send(res, 400, {
      success: false,
      message: "Unknown wallet action.",
    });
  } catch (error) {
    console.error("Wallet API error:", error.message);

    return send(res, 500, {
      success: false,
      message: "Wallet service temporarily unavailable.",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
};