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
  console.error("Withdrawal DB pool error:", err.code || err.name)
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
  await query(`CREATE TABLE IF NOT EXISTS public.transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    transaction_type TEXT NOT NULL,
    amount NUMERIC(20,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    network TEXT,
    tx_hash TEXT,
    payout_tx_hash TEXT,
    destination_address TEXT,
    admin_note TEXT,
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS public.wallet_balances (
    user_id BIGINT PRIMARY KEY,
    balance NUMERIC(30,2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS wallet_address TEXT`);
}

async function sanitizeUserId(raw) {
  const value = String(raw || "").trim();
  if (!/^\d{1,15}$/.test(value)) throw new Error("Invalid user ID.");
  return value;
}

async function getUserBalance(userId) {
  const rows = await query(
    `SELECT COALESCE(balance,0) AS balance
     FROM public.wallet_balances
     WHERE user_id=$1`,
    [userId]
  );

  return Number(rows[0]?.balance || 0);
}

async function requestWithdrawal(body) {
  await ensureTables();

  const userId = await sanitizeUserId(body.user_id);
  const amount = Number(body.amount);
  const destination = String(body.destination_address || "").trim();
  const network = String(body.network || "BSC").trim().slice(0, 50);

  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
    throw new Error("Enter a valid withdrawal amount.");
  }

  if (!destination) {
    throw new Error("Withdrawal address is required.");
  }

  const balance = await getUserBalance(userId);

  if (balance < amount) {
    throw new Error("Insufficient balance.");
  }

  const alreadyPending = await query(
    `SELECT id
     FROM public.transactions
     WHERE user_id=$1
       AND transaction_type='withdrawal'
       AND status='pending'
     LIMIT 1`,
    [userId]
  );

  if (alreadyPending.length) {
    return {
      ok: false,
      message: "You already have a pending withdrawal."
    };
  }

  const rows = await query(
    `INSERT INTO public.transactions (
       user_id, transaction_type, amount, status, network, destination_address, created_at, updated_at
     )
     VALUES ($1,'withdrawal',$2,'pending',$3,$4,NOW(),NOW())
     RETURNING id, user_id, transaction_type, amount, status, network, destination_address, created_at`,
    [userId, amount.toFixed(2), network, destination]
  );

  const locked = await query(
    `UPDATE public.wallet_balances
     SET balance = balance - $2,
         updated_at = NOW()
     WHERE user_id = $1
     RETURNING balance`,
    [userId, amount]
  );

  if (!locked.length) {
    await query(`DELETE FROM public.transactions WHERE id=$1`, [rows[0].id]);
    throw new Error("Unable to reserve balance.");
  }

  return {
    ok: true,
    transaction: rows[0],
    message: "Withdrawal request created."
  };
}

async function getUserWithdrawals(body) {
  await ensureTables();

  const userId = await sanitizeUserId(body.user_id);

  const rows = await query(
    `SELECT id, transaction_type, amount, status, network, tx_hash, payout_tx_hash, destination_address, admin_note, created_at, updated_at
     FROM public.transactions
     WHERE user_id=$1 AND transaction_type='withdrawal'
     ORDER BY id DESC
     LIMIT 50`,
    [userId]
  );

  return { ok: true, withdrawals: rows };
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
  const action = String(body.action || "").trim();

  try {
    let result;

    switch (action) {
      case "request":
        result = await requestWithdrawal(body);
        break;

      case "history":
        result = await getUserWithdrawals(body);
        break;

      default:
        throw new Error("Unsupported withdrawal action.");
    }

    return json(res, 200, result);
  } catch (error) {
    console.error("Withdrawal API error:", error.code || error.name || "Error");

    let message = "Withdrawal request failed.";

    if (error.message && /Invalid|Unsupported|Insufficient|required/.test(error.message)) {
      message = error.message;
    }

    return json(res, 400, { message });
  }
};
