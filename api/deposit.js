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
  console.error("Deposit DB pool error:", err.code || err.name)
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

async function createDeposit(body, req) {
  await ensureTables();

  const userId = await sanitizeUserId(body.user_id);
  const amount = Number(body.amount);
  const network = String(body.network || "BSC").trim().slice(0, 50);
  const txHash = String(body.tx_hash || "").trim().slice(0, 200);

  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
    throw new Error("Enter a valid deposit amount.");
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error("A valid transaction hash is required.");
  }

  const existing = await query(
    `SELECT id,status FROM public.transactions
     WHERE user_id=$1 AND transaction_type='deposit' AND LOWER(tx_hash)=LOWER($2)
     LIMIT 1`,
    [userId, txHash]
  );

  if (existing.length) {
    return {
      ok: true,
      transaction: existing[0],
      message: "Deposit already submitted."
    };
  }

  const rows = await query(
    `INSERT INTO public.transactions (
       user_id, transaction_type, amount, status, network, tx_hash, created_at, updated_at
     )
     VALUES ($1,'deposit',$2,'pending',$3,$4,NOW(),NOW())
     RETURNING id, user_id, transaction_type, amount, status, network, tx_hash, created_at`,
    [userId, amount.toFixed(2), network, txHash]
  );

  return {
    ok: true,
    transaction: rows[0],
    message: "Deposit submitted."
  };
}

async function getUserDeposits(body) {
  await ensureTables();

  const userId = await sanitizeUserId(body.user_id);
  const rows = await query(
    `SELECT id, transaction_type, amount, status, network, tx_hash, payout_tx_hash, destination_address, admin_note, created_at, updated_at
     FROM public.transactions
     WHERE user_id=$1 AND transaction_type='deposit'
     ORDER BY id DESC
     LIMIT 50`,
    [userId]
  );

  return { ok: true, deposits: rows };
}

async function verifyDeposit(body) {
  const userId = await sanitizeUserId(body.user_id);
  const txHash = String(body.tx_hash || "").trim();

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error("Invalid transaction hash.");
  }

  const rows = await query(
    `SELECT id, user_id, transaction_type, amount, status, network, tx_hash, created_at
     FROM public.transactions
     WHERE user_id=$1 AND transaction_type='deposit' AND LOWER(tx_hash)=LOWER($2)
     LIMIT 1`,
    [userId, txHash]
  );

  if (!rows.length) {
    return { ok: false, found: false, message: "Deposit not found." };
  }

  return {
    ok: true,
    found: true,
    transaction: rows[0]
  };
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
      case "create":
        result = await createDeposit(body, req);
        break;

      case "history":
        result = await getUserDeposits(body);
        break;

      case "verify":
        result = await verifyDeposit(body);
        break;

      default:
        throw new Error("Unsupported deposit action.");
    }

    return json(res, 200, result);
  } catch (error) {
    console.error("Deposit API error:", error.code || error.name || "Error");

    let message = "Deposit request failed.";

    if (error.message && /Invalid|Unsupported|valid|required/.test(error.message)) {
      message = error.message;
    }

    return json(res, 400, { message });
  }
};
