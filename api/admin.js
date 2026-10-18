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

pool.on("error", err => {
  console.error("Admin DB pool error:", err.code || err.name);
});

const COOKIE = "admin_session";
const SESSION_SECONDS = 7200;
const PAGE_SIZE_MAX = 100;
const EXPORT_MAX = 5000;

const STATUSES = new Set([
  "pending", "confirmed", "rejected", "completed", "failed",
  "open", "locked", "settled", "won", "lost", "cancelled"
]);

const USER_SEGMENTS = new Set([
  "all",
  "new_today",
  "new_7d",
  "active_24h",
  "active_7d",
  "inactive_30d"
]);

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(data));
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
    const index = item.indexOf("=");

    if (index < 0) continue;

    if (item.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(item.slice(index + 1).trim());
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
    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

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
    `${COOKIE}=${encodeURIComponent(value)}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
  );
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

async function audit(
  username,
  action,
  req,
  outcome = "success",
  targetType = null,
  targetId = null
) {
  try {
    await pool.query(
      `INSERT INTO public.admin_audit_log
       (admin_username, action, target_type, target_id,
        outcome, ip, created_at)
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
      `INSERT INTO public.admin_login_attempts
       (ip, success, attempted_at)
       VALUES ($1,$2,NOW())`,
      [ipAddress(req), Boolean(success)]
    );
  } catch (error) {
    console.error("Login attempt logging failed:", error.code || error.name);
  }
}

function pagination(body) {
  const page = Math.max(
    1,
    Math.min(1000000, Number.parseInt(body.page, 10) || 1)
  );

  const size = Math.max(
    1,
    Math.min(PAGE_SIZE_MAX, Number.parseInt(body.page_size, 10) || 20)
  );

  return {
    page,
    size,
    offset: (page - 1) * size
  };
}

async function dashboard() {
  const [
    totalsRows,
    roundStatuses,
    recentRounds,
    healthRows,
    userMetrics,
    securityRows
  ] = await Promise.all([
    query(`
      SELECT
        (SELECT COUNT(*) FROM public.users) AS users,
        (SELECT COUNT(*) FROM public.bets) AS bets,
        (SELECT COALESCE(SUM(stake),0)
         FROM public.bets) AS total_stake,
        (SELECT COALESCE(SUM(fee),0)
         FROM public.bets) AS total_fees,
        (SELECT COALESCE(SUM(payout),0)
         FROM public.bets) AS total_payouts,
        (SELECT COALESCE(SUM(balance),0)
         FROM public.wallet_balances) AS total_wallet_balance,
        (SELECT COALESCE(SUM(amount),0)
         FROM public.transactions
         WHERE transaction_type='deposit'
           AND status IN ('confirmed','completed'))
           AS total_deposits,
        (SELECT COUNT(*)
         FROM public.transactions
         WHERE transaction_type='deposit'
           AND status IN ('confirmed','completed'))
           AS deposit_count,
        (SELECT COALESCE(SUM(amount),0)
         FROM public.transactions
         WHERE transaction_type='withdrawal'
           AND status IN ('confirmed','completed'))
           AS total_withdrawals,
        (SELECT COUNT(*)
         FROM public.transactions
         WHERE transaction_type='withdrawal'
           AND status IN ('confirmed','completed'))
           AS withdrawal_count,
        (SELECT COALESCE(SUM(commission_amount),0)
         FROM public.referral_commissions) AS total_commissions
    `),

    query(`
      SELECT status, COUNT(*) AS count
      FROM public.game_rounds
      GROUP BY status
      ORDER BY status
    `),

    query(`
      SELECT
        r.round_code,
        r.status,
        r.starts_at,
        r.betting_closes_at,
        r.ends_at,
        CASE
          WHEN r.ends_at <= NOW() THEN r.result_number
          ELSE NULL
        END AS result_number,
        COUNT(b.id) AS bet_count,
        COALESCE(SUM(b.stake),0) AS total_stake,
        COALESCE(SUM(b.payout),0) AS total_payout,
        COUNT(b.id) FILTER (
          WHERE b.status='pending'
        ) AS pending_bets,
        (
          r.status='settled'
          AND COUNT(b.id) FILTER (
            WHERE b.status='pending'
          )=0
        ) AS payout_complete
      FROM public.game_rounds r
      LEFT JOIN public.bets b ON b.round_id=r.id
      GROUP BY r.id
      ORDER BY r.starts_at DESC
      LIMIT 10
    `),

    query(`
      SELECT
        (SELECT COUNT(*)
         FROM public.game_rounds
         WHERE ends_at<NOW()
           AND status<>'settled') AS overdue_rounds,
        (SELECT COUNT(*)
         FROM public.bets
         WHERE status='pending'
           AND created_at<NOW()-INTERVAL '10 minutes')
           AS old_pending_bets,
        (SELECT MAX(starts_at)
         FROM public.game_rounds) AS latest_round_start,
        (SELECT MAX(settled_at)
         FROM public.game_rounds
         WHERE status='settled') AS last_settled_at
    `),

    query(`
      SELECT
        (SELECT COUNT(*)
         FROM public.users
         WHERE created_at >= CURRENT_DATE
           AND created_at < CURRENT_DATE + INTERVAL '1 day')
           AS new_today,
        (SELECT COUNT(*)
         FROM public.users
         WHERE created_at >= NOW()-INTERVAL '7 days')
           AS new_7d,
        (SELECT COUNT(DISTINCT user_id)
         FROM public.bets
         WHERE created_at >= NOW()-INTERVAL '24 hours')
           AS active_24h,
        (SELECT COUNT(DISTINCT user_id)
         FROM public.bets
         WHERE created_at >= NOW()-INTERVAL '7 days')
           AS active_7d,
        (SELECT COUNT(*)
         FROM public.users u
         WHERE NOT EXISTS (
           SELECT 1
           FROM public.bets b
           WHERE b.user_id=u.id
             AND b.created_at >= NOW()-INTERVAL '30 days'
         )) AS inactive_30d
    `),

    query(`
      SELECT
        COUNT(*) FILTER (
          WHERE success=FALSE
            AND attempted_at>NOW()-INTERVAL '24 hours'
        ) AS failed_logins_24h,
        MAX(attempted_at) AS latest_login_attempt
      FROM public.admin_login_attempts
    `)
  ]);

  const health = healthRows[0] || {};

  return {
    totals: totalsRows[0] || {},
    user_metrics: userMetrics[0] || {},
    security: securityRows[0] || {},
    round_statuses: roundStatuses,
    recent_rounds: recentRounds,
    health: {
      database_ok: true,
      cron_ok:
        Number(health.overdue_rounds || 0) === 0 &&
        Number(health.old_pending_bets || 0) === 0,
      overdue_rounds: Number(health.overdue_rounds || 0),
      old_pending_bets: Number(health.old_pending_bets || 0),
      latest_round_start: health.latest_round_start,
      last_settled_at: health.last_settled_at
    }
  };
}

/*
 * The remaining backend functions are included in the complete file.
 * Download the full file above rather than copying this shortened
 * excerpt, so no functions or security checks are accidentally omitted.
 */