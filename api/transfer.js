"use strict";

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not configured.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});

pool.on("error", err =>
  console.error("Transfer DB pool error:", err.code || err.name)
);

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(JSON.stringify(data));
}

function validRequest(req) {
  if (req.headers["x-admin-request"] !== "1") return false;

  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function ensureTables() {
  await query(`CREATE TABLE IF NOT EXISTS public.wallet_balances (
    user_id BIGINT PRIMARY KEY,
    balance NUMERIC(30,2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS public.user_notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function sanitizeUserId(raw) {
  const value = String(raw || "").trim();
  if (!/^\d{1,15}$/.test(value)) throw new Error("Invalid user ID.");
  return value;
}

async function transferPoints(body) {
  await ensureTables();

  const fromUserId = await sanitizeUserId(body.from_user_id);
  const toUserId = await sanitizeUserId(body.to_user_id);
  const amount = Number(body.amount);

  if (fromUserId === toUserId) {
    throw new Error("Sender and recipient cannot be the same user.");
  }

  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
    throw new Error("Enter a valid amount.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const debit = await client.query(
      `UPDATE public.wallet_balances
       SET balance = balance - $1,
           updated_at = NOW()
       WHERE user_id = $2 AND balance >= $1
       RETURNING balance`,
      [amount, fromUserId]
    );

    if (!debit.rowCount) {
      throw new Error("Insufficient balance.");
    }

    await client.query(
      `INSERT INTO public.wallet_balances (user_id, balance, updated_at)
       VALUES ($1, 0, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [toUserId]
    );

    await client.query(
      `UPDATE public.wallet_balances
       SET balance = balance + $1,
           updated_at = NOW()
       WHERE user_id = $2`,
      [amount, toUserId]
    );

    await client.query(
      `INSERT INTO public.user_notifications (user_id, kind, title, message)
       VALUES ($1, 'transfer', 'Points received', $2),
              ($3, 'transfer', 'Points sent', $4)`,
      [toUserId, `You received ${amount} points.`, fromUserId, `You sent ${amount} points.`]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      message: "Transfer completed.",
      from_user_id: fromUserId,
      to_user_id: toUserId,
      amount
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { message: "Method not allowed." });
  }

  if (!validRequest(req)) {
    return json(res, 403, { message: "Request rejected." });
  }

  const body = req.body || {};

  try {
    const result = await transferPoints(body);
    return json(res, 200, result);
  } catch (error) {
    console.error("Transfer API error:", error.code || error.name || "Error");

    let message = "Transfer failed.";

    if (error.message && /Invalid|Insufficient|cannot be the same|required/.test(error.message)) {
      message = error.message;
    }

    return json(res, 400, { message });
  }
};
