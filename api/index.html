"use strict";

const crypto = require("crypto");
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
  console.error("DB pool error:", err.code || err.name)
);

const COOKIE = "admin_session";
const SESSION_SECONDS = 7200;

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
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

function ipAddress(req) {
  return String(
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    ""
  ).split(",")[0].trim().slice(0, 100);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function getConfig() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;

  if (
    !username ||
    !password ||
    password.length < 12 ||
    !secret ||
    secret.length < 32
  ) {
    throw new Error("Admin environment configuration is invalid.");
  }

  return { username, password };
}

function sign(value) {
  return crypto
    .createHmac("sha256", process.env.ADMIN_SESSION_SECRET)
    .update(value)
    .digest("base64url");
}

function createSession(username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
    nonce: crypto.randomBytes(16).toString("hex")
  })).toString("base64url");

  return `${payload}.${sign(payload)}`;
}

function readCookie(req, name) {
  for (const item of String(req.headers.cookie || "").split(";")) {
    const i = item.indexOf("=");
    if (i < 0) continue;
    if (item.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(item.slice(i + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!safeEqual(signature, sign(payload))) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      !session.username ||
      !Number.isFinite(session.exp) ||
      session.exp <= Date.now() / 1000 ||
      !safeEqual(session.username, process.env.ADMIN_USERNAME)
    ) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function setCookie(res, value, maxAge) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
  );
}

async function ensureCoreTables() {
  await query(`CREATE TABLE IF NOT EXISTS public.users (
    id BIGSERIAL PRIMARY KEY,
    telegram_id TEXT,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    profile_picture TEXT,
    wallet_address TEXT,
    country TEXT,
    language TEXT,
    referred_by TEXT,
    referral_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS public.wallet_balances (
    user_id BIGINT PRIMARY KEY,
    balance NUMERIC(30,2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

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

  await query(`CREATE TABLE IF NOT EXISTS public.user_profiles (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    bio TEXT,
    avatar_url TEXT,
    wallet_address TEXT,
    country TEXT,
    language TEXT,
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

  await query(`CREATE TABLE IF NOT EXISTS public.admin_login_attempts (
    id BIGSERIAL PRIMARY KEY,
    ip TEXT,
    success BOOLEAN NOT NULL DEFAULT FALSE,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS public.admin_audit_log (
    id BIGSERIAL PRIMARY KEY,
    admin_username TEXT,
    action TEXT,
    target_type TEXT,
    target_id TEXT,
    outcome TEXT,
    ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS profile_picture TEXT`);
  await query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS wallet_address TEXT`);
  await query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS country TEXT`);
  await query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS language TEXT`);
}

async function loginAllowed(req) {
  const ip = ipAddress(req);

  const rows = await query(
    `SELECT COUNT(*) FILTER (
       WHERE success = FALSE
       AND attempted_at > NOW() - INTERVAL '15 minutes'
     ) AS failed_ip
     FROM public.admin_login_attempts
     WHERE ip = $1`,
    [ip]
  );

  const globalRows = await query(
    `SELECT COUNT(*) AS failed_global
     FROM public.admin_login_attempts
     WHERE success = FALSE
     AND attempted_at > NOW() - INTERVAL '15 minutes'`
  );

  return (
    Number(rows[0]?.failed_ip || 0) < 5 &&
    Number(globalRows[0]?.failed_global || 0) < 30
  );
}

async function recordLogin(req, success) {
  try {
    await pool.query(
      `INSERT INTO public.admin_login_attempts (ip, success, attempted_at)
       VALUES ($1,$2,NOW())`,
      [ipAddress(req), !!success]
    );
  } catch (error) {
    console.error("Login attempt logging failed:", error.code || error.name);
  }
}

async function audit(username, action, req, outcome = "success", targetType = null, targetId = null) {
  try {
    await pool.query(
      `INSERT INTO public.admin_audit_log
       (admin_username, action, target_type, target_id, outcome, ip, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
      [
        String(username || "unknown").slice(0, 200),
        String(action).slice(0, 100),
        targetType ? String(targetType).slice(0, 100) : null,
        targetId == null ? null : String(targetId).slice(0, 100),
        String(outcome).slice(0, 50),
        ipAddress(req)
      ]
    );
  } catch (error) {
    console.error("Admin audit write failed:", error.code || error.name);
  }
}

async function adminLogin(req, res) {
  let settings;
  try {
    settings = getConfig();
  } catch {
    return json(res, 500, { message: "Admin configuration error. Check Vercel environment settings." });
  }

  const body = req.body || {};

  if (!(await loginAllowed(req))) {
    await recordLogin(req, false);
    await audit("unknown", "login_rate_limited", req, "blocked");
    return json(res, 429, { message: "Too many login attempts. Try again in 15 minutes." });
  }

  const ok =
    safeEqual(body.username, settings.username) &&
    safeEqual(body.password, settings.password);

  await recordLogin(req, ok);

  if (!ok) {
    await audit("unknown", "login", req, "failed");
    return json(res, 401, { message: "Invalid username or password." });
  }

  setCookie(res, createSession(settings.username), SESSION_SECONDS);
  await audit(settings.username, "login", req);
  return json(res, 200, { ok: true });
}

async function adminLogout(req, res) {
  setCookie(res, "", 0);
  return json(res, 200, { ok: true });
}

async function handleAdmin(req, res) {
  const body = req.body || {};
  const action = String(body.action || "").trim();

  if (action === "login") return adminLogin(req, res);
  if (action === "logout") return adminLogout(req, res);

  const session = verifySession(readCookie(req, COOKIE));
  if (!session) {
    return json(res, 401, { message: "Session expired. Please sign in again." });
  }

  try {
    if (action === "me") {
      return json(res, 200, { ok: true, username: session.username });
    }

    if (action === "dashboard") {
      return json(res, 200, { ok: true, message: "Dashboard ok" });
    }

    if (action === "security") {
      const rows = await query(`
        SELECT id, ip, success, attempted_at
        FROM public.admin_login_attempts
        ORDER BY attempted_at DESC
        LIMIT 50
      `);

      return json(res, 200, { ok: true, attempts: rows });
    }

    return json(res, 400, { message: "Unknown admin action." });
  } catch (error) {
    console.error("Admin error:", error);
    return json(res, 400, { message: "Admin request failed." });
  }
}

async function handleProfile(req, res) {
  const body = req.body || {};
  const action = String(body.action || "").trim();
  const userId = String(body.user_id || "").trim();

  if (!/^\d{1,15}$/.test(userId)) {
    return json(res, 400, { message: "Invalid user ID." });
  }

  await ensureCoreTables();

  if (action === "get") {
    const rows = await query(
      `SELECT u.id, u.telegram_id, u.username, u.first_name, u.last_name,
              u.profile_picture, u.wallet_address, u.country, u.language,
              w.balance,
              COALESCE(p.bio, '') AS bio,
              COALESCE(p.avatar_url, u.profile_picture, '') AS avatar_url
       FROM public.users u
       LEFT JOIN public.wallet_balances w ON w.user_id = u.id
       LEFT JOIN public.user_profiles p ON p.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [userId]
    );

    return json(res, 200, {
      ok: true,
      profile: rows[0] || null
    });
  }

  if (action === "save") {
    const username = String(body.username || "").trim().slice(0, 80);
    const firstName = String(body.first_name || "").trim().slice(0, 80);
    const lastName = String(body.last_name || "").trim().slice(0, 80);
    const bio = String(body.bio || "").trim().slice(0, 500);
    const avatarUrl = String(body.avatar_url || "").trim().slice(0, 500);
    const walletAddress = String(body.wallet_address || "").trim().slice(0, 200);
    const country = String(body.country || "").trim().slice(0, 80);
    const language = String(body.language || "").trim().slice(0, 40);

    await query(
      `INSERT INTO public.user_profiles (
         user_id, username, first_name, last_name, bio, avatar_url, wallet_address, country, language, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         bio = EXCLUDED.bio,
         avatar_url = EXCLUDED.avatar_url,
         wallet_address = EXCLUDED.wallet_address,
         country = EXCLUDED.country,
         language = EXCLUDED.language,
         updated_at = NOW()`,
      [userId, username || null, firstName || null, lastName || null, bio || null, avatarUrl || null, walletAddress || null, country || null, language || null]
    );

    await query(
      `UPDATE public.users
       SET username = COALESCE(NULLIF($2, ''), username),
           first_name = COALESCE(NULLIF($3, ''), first_name),
           last_name = COALESCE(NULLIF($4, ''), last_name),
           profile_picture = COALESCE(NULLIF($5, ''), profile_picture),
           wallet_address = COALESCE(NULLIF($6, ''), wallet_address),
           country = COALESCE(NULLIF($7, ''), country),
           language = COALESCE(NULLIF($8, ''), language)
       WHERE id = $1`,
      [userId, username, firstName, lastName, avatarUrl, walletAddress, country, language]
    );

    return json(res, 200, { ok: true, message: "Profile saved." });
  }

  if (action === "wallet") {
    const walletAddress = String(body.wallet_address || "").trim().slice(0, 200);
    if (!walletAddress) return json(res, 400, { message: "Wallet address is required." });

    await query(
      `INSERT INTO public.user_profiles (user_id, wallet_address, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET wallet_address = EXCLUDED.wallet_address, updated_at = NOW()`,
      [userId, walletAddress]
    );

    await query(`UPDATE public.users SET wallet_address = $2 WHERE id = $1`, [userId, walletAddress]);

    return json(res, 200, { ok: true, wallet_address: walletAddress });
  }

  if (action === "avatar") {
    const avatarUrl = String(body.avatar_url || "").trim().slice(0, 500);
    if (!avatarUrl) return json(res, 400, { message: "Avatar URL is required." });

    await query(
      `INSERT INTO public.user_profiles (user_id, avatar_url, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET avatar_url = EXCLUDED.avatar_url, updated_at = NOW()`,
      [userId, avatarUrl]
    );

    await query(`UPDATE public.users SET profile_picture = $2 WHERE id = $1`, [userId, avatarUrl]);

    return json(res, 200, { ok: true, avatar_url: avatarUrl });
  }

  return json(res, 400, { message: "Unsupported profile action." });
}

async function handleDeposit(req, res) {
  const body = req.body || {};
  const action = String(body.action || "").trim();
  const userId = String(body.user_id || "").trim();

  if (!/^\d{1,15}$/.test(userId)) {
    return json(res, 400, { message: "Invalid user ID." });
  }

  await ensureCoreTables();

  if (action === "create") {
    const amount = Number(body.amount);
    const network = String(body.network || "BSC").trim().slice(0, 50);
    const txHash = String(body.tx_hash || "").trim();

    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
      return json(res, 400, { message: "Enter a valid deposit amount." });
    }

    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return json(res, 400, { message: "A valid transaction hash is required." });
    }

    const existing = await query(
      `SELECT id, status
       FROM public.transactions
       WHERE user_id=$1 AND transaction_type='deposit' AND LOWER(tx_hash)=LOWER($2)
       LIMIT 1`,
      [userId, txHash]
    );

    if (existing.length) {
      return json(res, 200, { ok: true, transaction: existing[0], message: "Deposit already submitted." });
    }

    const rows = await query(
      `INSERT INTO public.transactions (
         user_id, transaction_type, amount, status, network, tx_hash, created_at, updated_at
       )
       VALUES ($1,'deposit',$2,'pending',$3,$4,NOW(),NOW())
       RETURNING id, user_id, transaction_type, amount, status, network, tx_hash, created_at`,
      [userId, amount.toFixed(2), network, txHash]
    );

    return json(res, 200, { ok: true, transaction: rows[0], message: "Deposit submitted." });
  }

  if (action === "history") {
    const rows = await query(
      `SELECT id, transaction_type, amount, status, network, tx_hash, payout_tx_hash, destination_address, admin_note, created_at, updated_at
       FROM public.transactions
       WHERE user_id=$1 AND transaction_type='deposit'
       ORDER BY id DESC
       LIMIT 50`,
      [userId]
    );

    return json(res, 200, { ok: true, deposits: rows });
  }

  if (action === "verify") {
    const txHash = String(body.tx_hash || "").trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return json(res, 400, { message: "Invalid transaction hash." });
    }

    const rows = await query(
      `SELECT id, user_id, transaction_type, amount, status, network, tx_hash, created_at
       FROM public.transactions
       WHERE user_id=$1 AND transaction_type='deposit' AND LOWER(tx_hash)=LOWER($2)
       LIMIT 1`,
      [userId, txHash]
    );

    if (!rows.length) {
      return json(res, 200, { ok: false, found: false, message: "Deposit not found." });
    }

    return json(res, 200, { ok: true, found: true, transaction: rows[0] });
  }

  return json(res, 400, { message: "Unsupported deposit action." });
}

async function handleWithdrawal(req, res) {
  const body = req.body || {};
  const action = String(body.action || "").trim();
  const userId = String(body.user_id || "").trim();

  if (!/^\d{1,15}$/.test(userId)) {
    return json(res, 400, { message: "Invalid user ID." });
  }

  await ensureCoreTables();

  if (action === "request") {
    const amount = Number(body.amount);
    const destination = String(body.destination_address || "").trim();
    const network = String(body.network || "BSC").trim().slice(0, 50);

    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
      return json(res, 400, { message: "Enter a valid withdrawal amount." });
    }

    if (!destination) {
      return json(res, 400, { message: "Withdrawal address is required." });
    }

    const balanceRows = await query(
      `SELECT COALESCE(balance,0) AS balance
       FROM public.wallet_balances
       WHERE user_id=$1`,
      [userId]
    );

    const balance = Number(balanceRows[0]?.balance || 0);

    if (balance < amount) {
      return json(res, 400, { message: "Insufficient balance." });
    }

    const pendingRows = await query(
      `SELECT id
       FROM public.transactions
       WHERE user_id=$1
         AND transaction_type='withdrawal'
         AND status='pending'
       LIMIT 1`,
      [userId]
    );

    if (pendingRows.length) {
      return json(res, 400, { message: "You already have a pending withdrawal." });
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
      return json(res, 400, { message: "Unable to reserve balance." });
    }

    return json(res, 200, { ok: true, transaction: rows[0], message: "Withdrawal request created." });
  }

  if (action === "history") {
    const rows = await query(
      `SELECT id, transaction_type, amount, status, network, tx_hash, payout_tx_hash, destination_address, admin_note, created_at, updated_at
       FROM public.transactions
       WHERE user_id=$1 AND transaction_type='withdrawal'
       ORDER BY id DESC
       LIMIT 50`,
      [userId]
    );

    return json(res, 200, { ok: true, withdrawals: rows });
  }

  return json(res, 400, { message: "Unsupported withdrawal action." });
}

async function handleTransfer(req, res) {
  const body = req.body || {};
  const fromUserId = String(body.from_user_id || "").trim();
  const toUserId = String(body.to_user_id || "").trim();
  const amount = Number(body.amount);

  if (!/^\d{1,15}$/.test(fromUserId) || !/^\d{1,15}$/.test(toUserId)) {
    return json(res, 400, { message: "Invalid user ID." });
  }

  if (fromUserId === toUserId) {
    return json(res, 400, { message: "Sender and recipient cannot be the same user." });
  }

  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
    return json(res, 400, { message: "Enter a valid amount." });
  }

  await ensureCoreTables();

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

    return json(res, 200, {
      ok: true,
      message: "Transfer completed.",
      from_user_id: fromUserId,
      to_user_id: toUserId,
      amount
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Transfer API error:", error.message);
    return json(res, 400, { message: error.message || "Transfer failed." });
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
  const type = String(body.type || "").trim();

  try {
    switch (type) {
      case "admin":
        return await handleAdmin(req, res);
      case "profile":
        return await handleProfile(req, res);
      case "deposit":
        return await handleDeposit(req, res);
      case "withdrawal":
        return await handleWithdrawal(req, res);
      case "transfer":
        return await handleTransfer(req, res);
      default:
        return json(res, 400, { message: "Unsupported API type." });
    }
  } catch (error) {
    console.error("Unified API error:", error);
    return json(res, 500, { message: "Server error." });
  }
};
