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
  console.error("Admin DB pool error:", err.code || err.name)
);

const COOKIE = "admin_session";
const SESSION_SECONDS = 7200;
const PAGE_SIZE_MAX = 100;
const EXPORT_MAX = 5000;
const RESULTS_CHANNEL = "@crypto_trader_results";

async function notifyTelegram(text, chats = [process.env.ADMIN_CHAT_ID]) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured." };
  chats = chats.filter(Boolean);
  const results = await Promise.all(chats.map(async (chatId) => {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000)
      });
      const payload = await response.json();
      return { chatId, ok: response.ok && payload.ok, payload };
    } catch (error) { return { chatId, ok: false, error: error.message }; }
  }));
  return { ok: results.every(item => item.ok), results };
}

async function telegramAdminAction(body, session, req) {
  await ensureManagementTables();
  if (body.mode === "history") {
    const page = Math.max(1, Number(body.page) || 1);
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number(body.page_size) || 25));
    const offset = (page - 1) * pageSize;
    const [rows, totals] = await Promise.all([
      query(`SELECT id,event_type,channel,message,status,telegram_message_id,error_message,attempt_count,created_at,sent_at FROM public.telegram_notifications ORDER BY id DESC LIMIT $1 OFFSET $2`, [pageSize, offset]),
      query(`SELECT COUNT(*)::int AS total FROM public.telegram_notifications`)
    ]);
    const total = Number(totals[0]?.total || 0);
    return { ok: true, notifications: rows, page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) };
  }
  const message = String(body.message || "").trim().slice(0, 4000);
  const channel = String(body.channel || process.env.ADMIN_CHAT_ID || "").trim().slice(0, 200);
  if (!message || !channel) throw new Error("Message and channel are required.");
  const created = await query(`INSERT INTO public.telegram_notifications(event_type,channel,message,status,attempt_count) VALUES($1,$2,$3,'pending',1) RETURNING id`, [body.event_type === "test" ? "test" : "admin", channel, message]);
  const result = await notifyTelegram(message, [channel]);
  if (result.ok) {
    const telegramId = result.results.find(item => item.ok)?.payload?.result?.message_id;
    await query(`UPDATE public.telegram_notifications SET status='sent',telegram_message_id=$1,sent_at=NOW() WHERE id=$2`, [telegramId ? String(telegramId) : null, created[0].id]);
  } else {
    const error = result.results.map(item => item.error || item.payload?.description).filter(Boolean).join("; ");
    await query(`UPDATE public.telegram_notifications SET status='failed',error_message=$1 WHERE id=$2`, [error.slice(0, 500), created[0].id]);
  }
  await audit(session.username, "telegram_notification", req, result.ok ? "success" : "failed", "telegram_notification", created[0].id);
  if (!result.ok) throw new Error("Telegram delivery failed. Check notification history.");
  return { ok: true, notification_id: created[0].id };
}

const STATUSES = new Set([
  "pending", "confirmed", "rejected", "completed", "failed",
  "open", "locked", "settled", "won", "lost", "cancelled"
]);

const USER_SEGMENTS = new Set([
  "all", "new_today", "new_7d", "active_24h",
  "active_7d", "inactive_30d"
]);

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

async function ensureDepositAddresses() {
  await query(`CREATE TABLE IF NOT EXISTS public.deposit_addresses (
    id BIGSERIAL PRIMARY KEY,
    coin TEXT NOT NULL,
    network TEXT NOT NULL,
    address TEXT NOT NULL,
    qr_payload TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function depositAddressConfig(body, session, req) {
  await ensureDepositAddresses();
  if (body.mode === "save") {
    const id = String(body.id || "");
    const coin = String(body.coin || "").trim().slice(0, 30);
    const network = String(body.network || "").trim().slice(0, 60);
    const address = String(body.address || "").trim().slice(0, 150);
    const qrPayload = String(body.qr_payload || address).trim().slice(0, 300);
    const active = body.is_active !== false;
    const order = Math.max(0, Math.min(100, Number(body.sort_order) || 0));
    if (!coin || !network || !address) throw new Error("Coin, network and address are required.");
    const rows = id
      ? await query(`UPDATE public.deposit_addresses SET coin=$1,network=$2,address=$3,qr_payload=$4,is_active=$5,sort_order=$6,updated_at=NOW() WHERE id=$7 RETURNING *`, [coin,network,address,qrPayload,active,order,id])
      : await query(`INSERT INTO public.deposit_addresses (coin,network,address,qr_payload,is_active,sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [coin,network,address,qrPayload,active,order]);
    if (!rows.length) throw new Error("Deposit address not found.");
    await audit(session.username, "deposit_address_save", req, "success", "deposit_address", rows[0].id);
  }
  if (body.mode === "delete") {
    const id = String(body.id || "");
    await query("DELETE FROM public.deposit_addresses WHERE id=$1", [id]);
    await audit(session.username, "deposit_address_delete", req, "success", "deposit_address", id);
  }
  return { ok: true, deposit_addresses: await query("SELECT * FROM public.deposit_addresses ORDER BY sort_order,id LIMIT 20") };
}

function ipAddress(req) {
  return String(
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    ""
  ).split(",")[0].trim().slice(0, 100);
}

  async function ensureManagementTables() {
    await query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE`);
    await query(`ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS payout_tx_hash TEXT`);
    await query(`CREATE TABLE IF NOT EXISTS public.gift_codes (
      id BIGSERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, points NUMERIC(20,2) NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS public.user_notifications (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS public.telegram_notifications (
      id BIGSERIAL PRIMARY KEY, event_type TEXT NOT NULL, channel TEXT NOT NULL,
      message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', telegram_message_id TEXT,
      error_message TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ
    )`);
  }

  async function userManagement(body, session, req) {
    await ensureManagementTables();
    const userId = String(body.user_id || "");
    if (!/^\d{1,15}$/.test(userId)) throw new Error("Invalid user ID.");
    const action = String(body.management_action || "");
    if (["block", "unblock"].includes(action)) {
      await query(`UPDATE public.users SET is_blocked=$1 WHERE id=$2`, [action === "block", userId]);
      await query(`INSERT INTO public.user_notifications (user_id,kind,title,message) VALUES ($1,'admin', $2, $3)`, [userId, action === "block" ? "Account blocked" : "Account unblocked", action === "block" ? "Your account has been blocked by admin." : "Your account has been unblocked."]);
    } else if (["add_fund", "remove_fund"].includes(action)) {
      const points = Number(body.points);
      if (!Number.isFinite(points) || points <= 0 || points > 100000000) throw new Error("Enter a valid points amount.");
      const delta = action === "add_fund" ? points : -points;
      const result = await query(`UPDATE public.wallet_balances SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2 AND balance+$1 >= 0 RETURNING balance`, [delta, userId]);
      if (!result.length) throw new Error("Insufficient balance or user wallet not found.");
      await query(`INSERT INTO public.user_notifications (user_id,kind,title,message) VALUES ($1,'wallet','Balance updated',$2)`, [userId, `${action === "add_fund" ? "Added" : "Removed"} ${points} points by admin.`]);
    } else if (action === "transfer_points") {
      const toUserId = String(body.to_user_id || "");
      const points = Number(body.points);
      if (!/^\d{1,15}$/.test(toUserId) || toUserId === userId || !Number.isFinite(points) || points <= 0 || points > 100000000) {
        throw new Error("Enter a valid different target user and points.");
      }
      const client = await pool.connect();
      try { await client.query("BEGIN");
        const recipient = await client.query(`SELECT id FROM public.users WHERE id=$1 FOR SHARE`, [toUserId]);
        if (!recipient.rowCount) throw new Error("Target user not found.");
        const debit = await client.query(`UPDATE public.wallet_balances SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2 AND balance >= $1 RETURNING balance`, [points, userId]);
        if (!debit.rowCount) throw new Error("Insufficient balance.");
        await client.query(`INSERT INTO public.wallet_balances(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`, [toUserId]);
        await client.query(`UPDATE public.wallet_balances SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2`, [points, toUserId]);
        await client.query(`INSERT INTO public.user_notifications(user_id,kind,title,message) VALUES($1,'transfer','Points received',$2),($3,'transfer','Points sent',$4)`, [toUserId, `You received ${points} points.`, userId, `You sent ${points} points.`]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    } else if (action === "create_gift") {
      const points = Number(body.points), maxUses = Math.min(1000000, Math.max(1, Math.floor(Number(body.max_uses || 1))));
      if (!Number.isFinite(points) || points <= 0) throw new Error("Enter valid gift points.");
      const code = String(body.code || `GIFT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`).trim().toUpperCase();
      const result = await query(`INSERT INTO public.gift_codes(code,points,max_uses,expires_at,created_by) VALUES($1,$2,$3,$4,$5) RETURNING code,points,max_uses,expires_at`, [code, points, maxUses, body.expires_at || null, session.username]);
      return { ok: true, gift_code: result[0] };
    } else throw new Error("Unknown user management action.");
    await audit(session.username, `user_${action}`, req, "success", "user", userId);
    return { ok: true };
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
    console.error(
      "Admin audit write failed:",
      error.code || error.name
    );
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
      [ipAddress(req), !!success]
    );
  } catch (error) {
    console.error(
      "Login attempt logging failed:",
      error.code || error.name
    );
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

/* =========================
   DASHBOARD
========================= */

async function dashboard() {
  const [
    totalsRows,
    roundStatuses,
    recentRounds,
    healthRows,
    userMetrics,
    securityRows
  ] = await Promise.all([
    query(`SELECT
      (SELECT COUNT(*) FROM public.users) AS users,
      (SELECT COUNT(*) FROM public.users WHERE is_blocked=TRUE) AS blocked_users,
      (SELECT COUNT(*) FROM public.bets) AS bets,
      (SELECT COALESCE(SUM(stake),0) FROM public.bets) AS total_stake,
      (SELECT COALESCE(SUM(fee),0) FROM public.bets) AS total_fees,
      (SELECT COALESCE(SUM(payout),0) FROM public.bets) AS total_payouts,
      (SELECT COALESCE(SUM(balance),0) FROM public.wallet_balances) AS total_wallet_balance,
      (SELECT COALESCE(SUM(amount),0) FROM public.transactions
        WHERE transaction_type='deposit'
        AND status IN ('confirmed','completed')) AS total_deposits,
      (SELECT COUNT(*) FROM public.transactions
        WHERE transaction_type='deposit'
        AND status IN ('confirmed','completed')) AS deposit_count,
      (SELECT COALESCE(SUM(amount),0) FROM public.transactions
        WHERE transaction_type='deposit' AND status IN ('confirmed','completed')
        AND created_at >= CURRENT_DATE) AS deposits_today,
      (SELECT COUNT(*) FROM public.transactions
        WHERE transaction_type='deposit' AND status='pending') AS pending_deposits,
      (SELECT COALESCE(SUM(amount),0) FROM public.transactions
        WHERE transaction_type='deposit' AND status='pending') AS pending_deposit_amount,
      (SELECT COALESCE(SUM(amount),0) FROM public.transactions
        WHERE transaction_type='withdrawal'
        AND status IN ('confirmed','completed')) AS total_withdrawals,
      (SELECT COUNT(*) FROM public.transactions
        WHERE transaction_type='withdrawal'
        AND status IN ('confirmed','completed')) AS withdrawal_count,
      (SELECT COALESCE(SUM(amount),0) FROM public.transactions
        WHERE transaction_type='withdrawal' AND status IN ('confirmed','completed')
        AND created_at >= CURRENT_DATE) AS withdrawals_today,
      (SELECT COUNT(*) FROM public.transactions
        WHERE transaction_type='withdrawal' AND status='pending') AS pending_withdrawals,
      (SELECT COALESCE(SUM(amount),0) FROM public.transactions
        WHERE transaction_type='withdrawal' AND status='pending') AS pending_withdrawal_amount,
      (SELECT COALESCE(SUM(commission_amount),0)
        FROM public.referral_commissions) AS total_commissions,
      (SELECT COUNT(*) FROM public.users WHERE referred_by IS NOT NULL) AS total_referrals`),

    query(`SELECT status, COUNT(*) AS count
      FROM public.game_rounds
      GROUP BY status
      ORDER BY status`),

    query(`SELECT
      r.round_code,
      r.status,
      r.starts_at,
      r.betting_closes_at,
      r.ends_at,
      CASE WHEN r.ends_at <= NOW()
        THEN r.result_number ELSE NULL END AS result_number,
      COUNT(b.id) AS bet_count,
      COALESCE(SUM(b.stake),0) AS total_stake,
      COALESCE(SUM(b.payout),0) AS total_payout,
      COUNT(b.id) FILTER (WHERE b.status='pending') AS pending_bets,
      (r.status='settled'
        AND COUNT(b.id) FILTER (WHERE b.status='pending')=0)
        AS payout_complete
      FROM public.game_rounds r
      LEFT JOIN public.bets b ON b.round_id=r.id
      GROUP BY r.id
      ORDER BY r.starts_at DESC
      LIMIT 10`),

    query(`SELECT
      (SELECT COUNT(*) FROM public.game_rounds
        WHERE ends_at<NOW() AND status<>'settled') AS overdue_rounds,
      (SELECT COUNT(*) FROM public.bets
        WHERE status='pending'
        AND created_at<NOW()-INTERVAL '10 minutes') AS old_pending_bets,
      (SELECT MAX(starts_at) FROM public.game_rounds)
        AS latest_round_start,
      (SELECT MAX(settled_at) FROM public.game_rounds
        WHERE status='settled') AS last_settled_at`),

    query(`SELECT
      (SELECT COUNT(*) FROM public.users
        WHERE created_at >= CURRENT_DATE
        AND created_at < CURRENT_DATE + INTERVAL '1 day') AS new_today,
      (SELECT COUNT(*) FROM public.users
        WHERE created_at >= NOW()-INTERVAL '7 days') AS new_7d,
      (SELECT COUNT(DISTINCT user_id) FROM public.bets
        WHERE created_at >= NOW()-INTERVAL '24 hours') AS active_24h,
      (SELECT COUNT(DISTINCT user_id) FROM public.bets
        WHERE created_at >= NOW()-INTERVAL '7 days') AS active_7d,
      (SELECT COUNT(*) FROM public.users u
        WHERE NOT EXISTS (
          SELECT 1 FROM public.bets b
          WHERE b.user_id=u.id
          AND b.created_at >= NOW()-INTERVAL '30 days'
        )) AS inactive_30d`),

    query(`SELECT
      COUNT(*) FILTER (
        WHERE success=FALSE
        AND attempted_at>NOW()-INTERVAL '24 hours'
      ) AS failed_logins_24h,
      MAX(attempted_at) AS latest_login_attempt
      FROM public.admin_login_attempts`)
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

/* =========================
   LIST CONFIGURATION
========================= */

const LISTS = {
  users: {
    select: `u.id,u.telegram_id,u.username,w.balance,
      u.referred_by,u.referral_code,u.created_at,
      (SELECT COUNT(*) FROM public.users c
       WHERE c.referred_by=u.id) AS referral_count`,
    from: `public.users u
      LEFT JOIN public.wallet_balances w ON w.user_id=u.id`,
    order: "u.id DESC"
  },

  wallets: {
    select: `w.user_id,u.telegram_id,u.username,
      w.balance,w.updated_at`,
    from: `public.wallet_balances w
      LEFT JOIN public.users u ON u.id=w.user_id`,
    order: "w.user_id DESC"
  },

  transactions: {
select: `id,user_id,transaction_type,amount,status,
  network,tx_hash,payout_tx_hash,destination_address,admin_note,
  reviewed_at,reviewed_by,created_at,updated_at`,
from: "public.transactions",
  order: "id DESC"
  },

  rounds: {
    select: `r.round_code,r.status,r.starts_at,
      r.betting_closes_at,r.ends_at,
      CASE WHEN r.ends_at<=NOW()
        THEN r.result_number ELSE NULL END AS result_number,
      COUNT(b.id) AS bet_count,
      COALESCE(SUM(b.stake),0) AS total_stake,
      COALESCE(SUM(b.payout),0) AS total_payout,
      COUNT(b.id) FILTER (WHERE b.status='pending') AS pending_bets,
      (r.status='settled'
        AND COUNT(b.id) FILTER (WHERE b.status='pending')=0)
        AS payout_complete`,
    from: `public.game_rounds r
      LEFT JOIN public.bets b ON b.round_id=r.id`,
    order: "r.starts_at DESC",
    group: "GROUP BY r.id"
  },

  bets: {
    select: `b.id,b.user_id,b.round_id,r.round_code,
      b.bet_type,b.selection,b.stake,b.fee,b.status,
      CASE WHEN r.ends_at<=NOW()
        THEN r.result_number ELSE NULL END AS result_number,
      b.payout,b.created_at,b.settled_at`,
    from: `public.bets b
      LEFT JOIN public.game_rounds r ON r.id=b.round_id`,
    order: "b.id DESC"
  },

  audit: {
    select: `id,created_at,admin_username,action,
      target_type,target_id,outcome,ip`,
    from: "public.admin_audit_log",
    order: "id DESC"
  }
};

function addFilter(conditions, params, sql, value) {
  params.push(value);
  conditions.push(sql.replace("?", `$${params.length}`));
}

function userSegmentSql(segment) {
  switch (segment) {
    case "new_today":
      return `u.created_at >= CURRENT_DATE
        AND u.created_at < CURRENT_DATE + INTERVAL '1 day'`;

    case "new_7d":
      return `u.created_at >= NOW()-INTERVAL '7 days'`;

    case "active_24h":
      return `EXISTS (
        SELECT 1 FROM public.bets bx
        WHERE bx.user_id=u.id
        AND bx.created_at>=NOW()-INTERVAL '24 hours'
      )`;

    case "active_7d":
      return `EXISTS (
        SELECT 1 FROM public.bets bx
        WHERE bx.user_id=u.id
        AND bx.created_at>=NOW()-INTERVAL '7 days'
      )`;

    case "inactive_30d":
      return `NOT EXISTS (
        SELECT 1 FROM public.bets bx
        WHERE bx.user_id=u.id
        AND bx.created_at>=NOW()-INTERVAL '30 days'
      )`;

    default:
      return null;
  }
}

/* =========================
   PAGINATED LISTS
========================= */

async function listAction(action, body) {
  const cfg = LISTS[action];

  if (!cfg) throw new Error("Unsupported list action.");

  const { page, size, offset } = pagination(body);
  const conditions = [];
  const params = [];

  if (action === "users") {
    const segment = String(body.segment || "all");

    if (!USER_SEGMENTS.has(segment)) {
      throw new Error("Invalid user segment.");
    }

    const segmentSql = userSegmentSql(segment);
    if (segmentSql) conditions.push(segmentSql);

    if (body.q) {
      const q = String(body.q).trim().slice(0, 100);

      if (/^\d+$/.test(q)) {
        params.push(q);
        conditions.push(
          `(CAST(u.telegram_id AS TEXT)=$${params.length}
            OR CAST(u.id AS TEXT)=$${params.length})`
        );
      } else {
        addFilter(
          conditions,
          params,
          "u.username ILIKE ?",
          `%${q}%`
        );
      }
    }
  }

  if (action === "wallets" && body.q) {
    const q = String(body.q).trim().slice(0, 100);

    if (/^\d+$/.test(q)) {
      addFilter(
        conditions,
        params,
        "CAST(w.user_id AS TEXT)=?",
        q
      );
    } else {
      addFilter(
        conditions,
        params,
        "u.username ILIKE ?",
        `%${q}%`
      );
    }
  }

  if (action === "transactions") {
    const type = body.type || body.transaction_type;

    if (type) {
      if (!["deposit", "withdrawal"].includes(String(type))) {
        throw new Error("Invalid transaction type.");
      }

      addFilter(
        conditions,
        params,
        "transaction_type=?",
        String(type)
      );
    }

    if (body.user_id) {
      if (!/^\d{1,15}$/.test(String(body.user_id))) {
        throw new Error("Invalid user ID.");
      }

      addFilter(
        conditions,
        params,
        "user_id=?",
        String(body.user_id)
      );
    }

    if (body.status) {
      const status = String(body.status);

      if (!STATUSES.has(status)) {
        throw new Error("Invalid status.");
      }

      addFilter(conditions, params, "status=?", status);
    }
  }

  if (action === "rounds" && body.q) {
    addFilter(conditions, params, "r.round_code ILIKE ?", `%${String(body.q).trim().slice(0, 100)}%`);
  }

  if (action === "bets") {
    if (body.q) {
      addFilter(conditions, params, "r.round_code ILIKE ?", `%${String(body.q).trim().slice(0, 100)}%`);
    }

    if (body.user_id) {
      if (!/^\d{1,15}$/.test(String(body.user_id))) {
        throw new Error("Invalid user ID.");
      }

      addFilter(
        conditions,
        params,
        "b.user_id=?",
        String(body.user_id)
      );
    }

    if (body.round_code) {
      addFilter(
        conditions,
        params,
        "r.round_code=?",
        String(body.round_code).slice(0, 100)
      );
    }

    if (body.status) {
      const status = String(body.status);

      if (!STATUSES.has(status)) {
        throw new Error("Invalid status.");
      }

      addFilter(conditions, params, "b.status=?", status);
    }
  }

  if (action === "rounds" && body.status) {
    const status = String(body.status);

    if (!STATUSES.has(status)) {
      throw new Error("Invalid status.");
    }

    addFilter(conditions, params, "r.status=?", status);
  }

  if (action === "audit") {
    if (body.outcome) {
      addFilter(
        conditions,
        params,
        "outcome=?",
        String(body.outcome).slice(0, 50)
      );
    }

    if (body.action_filter) {
      addFilter(
        conditions,
        params,
        "action ILIKE ?",
        `%${String(body.action_filter).slice(0, 80)}%`
      );
    }
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const countSql = action === "rounds"
    ? `SELECT COUNT(DISTINCT r.id) AS total
       FROM ${cfg.from} ${where}`
    : `SELECT COUNT(*) AS total
       FROM ${cfg.from} ${where}`;

  const countRows = await query(countSql, params);

  const rows = await query(
    `SELECT ${cfg.select}
     FROM ${cfg.from}
     ${where}
     ${cfg.group || ""}
     ORDER BY ${cfg.order}
     LIMIT $${params.length + 1}
     OFFSET $${params.length + 2}`,
    [...params, size, offset]
  );

  const total = Number(countRows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / size));

  return {
    [action === "audit" ? "entries" : action]: rows,
    pagination: {
      page,
      page_size: size,
      total,
      total_pages: totalPages,
      has_previous: page > 1,
      has_next: page < totalPages
    }
  };
}

/* =========================
   ANALYTICS
========================= */

async function analytics() {
  const [
    daily,
    resultRows,
    topUsers,
    largeStakes,
    highReturnUsers,
    userMetrics
  ] = await Promise.all([
    query(`WITH days AS (
      SELECT generate_series(
        CURRENT_DATE-INTERVAL '13 days',
        CURRENT_DATE,
        INTERVAL '1 day'
      )::date AS day
    )
    SELECT d.day,
      COUNT(b.id) AS bets,
      COALESCE(SUM(b.stake),0) AS stake,
      COALESCE(SUM(b.payout),0) AS payout,
      COALESCE(SUM(b.stake),0)-COALESCE(SUM(b.payout),0) AS net,
      COUNT(DISTINCT b.user_id) AS active_users,
      (SELECT COUNT(*) FROM public.users u
       WHERE u.created_at>=d.day
       AND u.created_at<d.day+INTERVAL '1 day') AS new_users
    FROM days d
    LEFT JOIN public.bets b
      ON b.created_at>=d.day
      AND b.created_at<d.day+INTERVAL '1 day'
    GROUP BY d.day
    ORDER BY d.day`),

    query(`SELECT result_number,COUNT(*) AS count
      FROM public.game_rounds
      WHERE status='settled'
      AND result_number BETWEEN 0 AND 9
      GROUP BY result_number
      ORDER BY result_number`),

    query(`SELECT u.id,u.username,
      COUNT(b.id) AS bets,
      COALESCE(SUM(b.stake),0) AS stake,
      COALESCE(SUM(b.payout),0) AS payout,
      COALESCE(SUM(b.stake),0)-COALESCE(SUM(b.payout),0) AS user_net
      FROM public.users u
      JOIN public.bets b ON b.user_id=u.id
      GROUP BY u.id,u.username
      ORDER BY SUM(b.stake) DESC
      LIMIT 10`),

    query(`SELECT b.id,b.user_id,r.round_code,
      b.bet_type,b.stake,b.created_at
      FROM public.bets b
      LEFT JOIN public.game_rounds r ON r.id=b.round_id
      ORDER BY b.stake DESC
      LIMIT 20`),

    query(`SELECT user_id,
      COUNT(*) AS bets,
      COALESCE(SUM(stake),0) AS stake,
      COALESCE(SUM(payout),0) AS payout,
      ROUND(
        100.0*COALESCE(SUM(payout),0)/NULLIF(SUM(stake),0),
        2
      ) AS return_percent
      FROM public.bets
      GROUP BY user_id
      HAVING SUM(stake)>0
      ORDER BY SUM(payout)/NULLIF(SUM(stake),0) DESC
      LIMIT 10`),

    query(`SELECT
      (SELECT COUNT(*) FROM public.users
       WHERE created_at>=CURRENT_DATE
       AND created_at<CURRENT_DATE+INTERVAL '1 day') AS new_today,
      (SELECT COUNT(*) FROM public.users
       WHERE created_at>=NOW()-INTERVAL '7 days') AS new_7d,
      (SELECT COUNT(DISTINCT user_id) FROM public.bets
       WHERE created_at>=NOW()-INTERVAL '24 hours') AS active_24h,
      (SELECT COUNT(DISTINCT user_id) FROM public.bets
       WHERE created_at>=NOW()-INTERVAL '7 days') AS active_7d,
      (SELECT COUNT(*) FROM public.users u
       WHERE NOT EXISTS (
         SELECT 1 FROM public.bets b
         WHERE b.user_id=u.id
         AND b.created_at>=NOW()-INTERVAL '30 days'
       )) AS inactive_30d`)
  ]);

  const counts = Array(10).fill(0);

  for (const row of resultRows) {
    counts[Number(row.result_number)] = Number(row.count);
  }

  const totalRounds = counts.reduce((a, b) => a + b, 0);

  return {
    daily,
    fairness: {
      counts,
      total_rounds: totalRounds,
      verdict: totalRounds < 100
        ? "Not enough settled rounds for a useful statistical check"
        : "Distribution available; not proof of fairness"
    },
    top_users: topUsers,
    large_stakes: largeStakes,
    high_return_users: highReturnUsers,
    user_metrics: userMetrics[0] || {}
  };
}

/* =========================
   RECONCILIATION
========================= */

async function reconcile() {
  const rows = await query(`SELECT
    (SELECT COALESCE(SUM(balance),0)
      FROM public.wallet_balances) AS wallet_total,
    (SELECT COALESCE(SUM(commission_amount),0)
      FROM public.referral_commissions) AS commissions,
    (SELECT COALESCE(SUM(stake),0)
      FROM public.bets) AS bets_stake,
    (SELECT COALESCE(SUM(payout),0)
      FROM public.bets WHERE status='won') AS bets_payout,
    (SELECT COUNT(*) FROM public.bets) AS bet_count,
    (SELECT COUNT(*) FROM public.transactions
      WHERE transaction_type='bet'
      AND status IN ('confirmed','completed')) AS bet_tx,
    (SELECT COUNT(*) FROM public.transactions
      WHERE transaction_type='payout'
      AND status IN ('confirmed','completed')) AS payout_tx,
    (SELECT COUNT(*) FROM public.bets
      WHERE status='won') AS paid_bets`);

  const t = rows[0] || {};

  return {
    clean: false,
    totals: {
      wallet_total: Number(t.wallet_total || 0),
      ledger_net: null,
      commissions: Number(t.commissions || 0),
      unrecorded: "Requires full transaction ledger mapping",
      bets_stake: Number(t.bets_stake || 0),
      bet_tx: Number(t.bet_tx || 0),
      stake_diff: "Requires transaction ledger mapping",
      bets_payout: Number(t.bets_payout || 0),
      payout_tx: Number(t.payout_tx || 0),
      payout_diff: "Requires payout ledger mapping",
      bet_count_diff:
        Number(t.bet_count || 0) - Number(t.bet_tx || 0),
      payout_count_diff:
        Number(t.paid_bets || 0) - Number(t.payout_tx || 0)
    },
    mismatches: []
  };
}

/* =========================
   USER DETAILS
========================= */

async function userDetail(userId) {
  const profiles = await query(
    `SELECT u.id,u.telegram_id,u.username,w.balance,
      u.referral_code,u.referred_by,u.created_at
     FROM public.users u
     LEFT JOIN public.wallet_balances w ON w.user_id=u.id
     WHERE u.id=$1
     LIMIT 1`,
    [userId]
  );

  if (!profiles.length) return null;

  const [
    stats,
    recentBets,
    recentTransactions,
    commissions,
    referralTree,
    generated,
    rewards,
    activity
  ] = await Promise.all([
    query(`SELECT COUNT(*) AS bets,
      COALESCE(SUM(stake),0) AS stake,
      COALESCE(SUM(payout),0) AS payout,
      COUNT(*) FILTER(WHERE status='won') AS wins,
      COUNT(*) FILTER(WHERE status='lost') AS losses
      FROM public.bets WHERE user_id=$1`, [userId]),

    query(`SELECT b.id,r.round_code,b.bet_type,b.selection,
      b.stake,b.fee,b.status,
      CASE WHEN r.ends_at<=NOW()
        THEN r.result_number ELSE NULL END AS result_number,
      b.payout,b.created_at,b.settled_at
      FROM public.bets b
      LEFT JOIN public.game_rounds r ON r.id=b.round_id
      WHERE b.user_id=$1
      ORDER BY b.id DESC
      LIMIT 20`, [userId]),

    query(`SELECT id,transaction_type,amount,status,network,
      tx_hash,destination_address,admin_note,reviewed_at,
      reviewed_by,created_at
      FROM public.transactions
      WHERE user_id=$1
      ORDER BY id DESC
      LIMIT 20`, [userId]),

    query(`SELECT referral_level,COUNT(*) AS count,
      COALESCE(SUM(commission_amount),0) AS total
      FROM public.referral_commissions
      WHERE referrer_user_id=$1
      GROUP BY referral_level
      ORDER BY referral_level`, [userId]),

    query(`WITH RECURSIVE rt AS (
      SELECT id,username,referred_by,created_at,1 AS level
      FROM public.users WHERE referred_by=$1
      UNION ALL
      SELECT u.id,u.username,u.referred_by,u.created_at,rt.level+1
      FROM public.users u
      JOIN rt ON u.referred_by=rt.id
      WHERE rt.level<3
    )
    SELECT id,username,referred_by,created_at,level
    FROM rt ORDER BY level,id LIMIT 200`, [userId]),

    query(`SELECT COALESCE(SUM(commission_amount),0) AS total
      FROM public.referral_commissions
      WHERE source_user_id=$1`, [userId]),

    query(`SELECT COUNT(*) AS total,
      COALESCE(SUM(reward_points),0) AS points,
      COUNT(*) FILTER(WHERE status='credited') AS credited
      FROM public.referral_rewards
      WHERE referrer_user_id=$1`, [userId]),

    query(`SELECT MAX(created_at) AS last_bet_at,
      COUNT(*) FILTER(
        WHERE created_at>=NOW()-INTERVAL '24 hours'
      ) AS bets_24h,
      COUNT(*) FILTER(
        WHERE created_at>=NOW()-INTERVAL '7 days'
      ) AS bets_7d
      FROM public.bets WHERE user_id=$1`, [userId])
  ]);

  return {
    profile: profiles[0],
    stats: stats[0] || {},
    recent_bets: recentBets,
    recent_transactions: recentTransactions,
    referral_tree: referralTree,
    commissions_earned: commissions,
    commissions_generated: Number(generated[0]?.total || 0),
    referral_rewards: rewards[0] || {},
    activity: activity[0] || {}
  };
}

/* =========================
   SEARCH
========================= */

async function search(q) {
  q = String(q || "").trim().slice(0, 100);

  if (!q) return { users: [], rounds: [], bets: [] };

  const users = await query(
    `SELECT u.id,u.telegram_id,u.username,w.balance
     FROM public.users u
     LEFT JOIN public.wallet_balances w ON w.user_id=u.id
     WHERE CAST(u.id AS TEXT)=$1
        OR CAST(u.telegram_id AS TEXT)=$1
        OR u.username ILIKE $2
     ORDER BY u.id DESC LIMIT 20`,
    [q, `%${q}%`]
  );

  const rounds = await query(
    `SELECT round_code,status,starts_at,ends_at
     FROM public.game_rounds
     WHERE round_code=$1
     ORDER BY starts_at DESC LIMIT 10`,
    [q]
  );

  const bets = /^\d+$/.test(q)
    ? await query(
        `SELECT b.id,b.user_id,r.round_code,
          b.bet_type,b.stake,b.status
         FROM public.bets b
         LEFT JOIN public.game_rounds r ON r.id=b.round_id
         WHERE b.id=$1 LIMIT 10`,
        [q]
      )
    : [];

  return { users, rounds, bets };
}

/* =========================
   CSV EXPORT
========================= */

function csvCell(value) {
  let s = value == null ? "" : String(value);

  if (/^[\s]*[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }

  return `"${s.replace(/"/g, '""')}"`;
}

async function exportCsv(body) {
  const kind = String(body.kind || "");
  let sql = "";
  const params = [];
  const conditions = [];

  if (kind === "users") {
    const segment = String(body.segment || "all");

    if (!USER_SEGMENTS.has(segment)) {
      throw new Error("Invalid user segment.");
    }

    const segmentSql = userSegmentSql(segment);
    if (segmentSql) conditions.push(segmentSql);

    if (body.q) {
      const q = String(body.q).trim().slice(0, 100);

      if (/^\d+$/.test(q)) {
        params.push(q);
        conditions.push(
          `(CAST(u.telegram_id AS TEXT)=$${params.length}
            OR CAST(u.id AS TEXT)=$${params.length})`
        );
      } else {
        params.push(`%${q}%`);
        conditions.push(`u.username ILIKE $${params.length}`);
      }
    }

    sql = `SELECT u.id,u.telegram_id,u.username,w.balance,
      u.referred_by,u.referral_code,u.created_at
      FROM public.users u
      LEFT JOIN public.wallet_balances w ON w.user_id=u.id
      ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
      ORDER BY u.id DESC LIMIT ${EXPORT_MAX}`;
  } else if (kind === "bets") {
    if (body.user_id) {
      if (!/^\d{1,15}$/.test(String(body.user_id))) {
        throw new Error("Invalid user ID.");
      }

      params.push(String(body.user_id));
      conditions.push(`b.user_id=$${params.length}`);
    }

    if (body.round_code) {
      params.push(String(body.round_code).slice(0, 100));
      conditions.push(`r.round_code=$${params.length}`);
    }

    if (body.status) {
      const status = String(body.status);

      if (!STATUSES.has(status)) {
        throw new Error("Invalid status.");
      }

      params.push(status);
      conditions.push(`b.status=$${params.length}`);
    }

    sql = `SELECT b.id,b.user_id,r.round_code,b.bet_type,
      b.selection,b.stake,b.fee,b.status,b.payout,
      b.created_at,b.settled_at
      FROM public.bets b
      LEFT JOIN public.game_rounds r ON r.id=b.round_id
      ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
      ORDER BY b.id DESC LIMIT ${EXPORT_MAX}`;
  } else if (kind === "transactions") {
    const type = body.type || body.transaction_type;

    if (type) {
      if (!["deposit", "withdrawal"].includes(String(type))) {
        throw new Error("Invalid transaction type.");
      }

      params.push(String(type));
      conditions.push(`transaction_type=$${params.length}`);
    }

    if (body.user_id) {
      if (!/^\d{1,15}$/.test(String(body.user_id))) {
        throw new Error("Invalid user ID.");
      }

      params.push(String(body.user_id));
      conditions.push(`user_id=$${params.length}`);
    }

    if (body.status) {
      const status = String(body.status);

      if (!STATUSES.has(status)) {
        throw new Error("Invalid status.");
      }

      params.push(status);
      conditions.push(`status=$${params.length}`);
    }

    sql = `SELECT id,user_id,transaction_type,amount,status,
      network,tx_hash,destination_address,admin_note,
      reviewed_at,reviewed_by,created_at,updated_at
      FROM public.transactions
      ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
      ORDER BY id DESC LIMIT ${EXPORT_MAX}`;
  } else {
    throw new Error("Invalid export type.");
  }

  const rows = await query(sql, params);
  const columns = rows.length ? Object.keys(rows[0]) : [];

  const csv = [
    columns.map(csvCell).join(","),
    ...rows.map(row =>
      columns.map(column => csvCell(row[column])).join(",")
    )
  ].join("\r\n");

  return {
    csv,
    row_count: rows.length,
    truncated: rows.length === EXPORT_MAX
  };
}

/* =========================
   WALLET TRANSACTION REVIEW (UPDATED: 1 USDT = 100 POINTS)
========================= */

async function reviewWalletTransaction(action, body, session, req) {
  const transactionId = String(body.transaction_id || "");

  if (!/^\d{1,15}$/.test(transactionId)) {
    throw new Error("Invalid transaction ID.");
  }

  const note = String(body.admin_note || "").trim().slice(0, 500);
  const payoutTxHash = String(body.payout_tx_hash || "").trim().slice(0, 200);
  const reviewNote = payoutTxHash ? `${note}${note ? " | " : ""}Payout TX: ${payoutTxHash}`.slice(0, 500) : note;
  if (action === "withdrawal_approve" && !/^0x[a-fA-F0-9]{64}$/.test(payoutTxHash)) {
  throw new Error("A valid payout transaction hash is required.");
  }

  await ensureManagementTables();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT t.id,t.user_id,t.transaction_type,t.amount,t.status,
        t.network,t.tx_hash,t.payout_tx_hash,u.telegram_id,u.username,u.first_name,u.last_name
       FROM public.transactions t
       JOIN public.users u ON u.id=t.user_id
       WHERE t.id=$1
       FOR UPDATE`,
      [transactionId]
    );

    if (!result.rows.length) {
      throw new Error("Transaction not found.");
    }

    const tx = result.rows[0];

    if (tx.status !== "pending") {
      throw new Error("Transaction is not pending.");
    }

    if (!["deposit", "withdrawal"].includes(tx.transaction_type)) {
      throw new Error("Unsupported wallet transaction type.");
    }

    if (
      action.startsWith("deposit_") &&
      tx.transaction_type !== "deposit"
    ) {
      throw new Error("This is not a deposit transaction.");
    }

    if (
      action.startsWith("withdrawal_") &&
      tx.transaction_type !== "withdrawal"
    ) {
      throw new Error("This is not a withdrawal transaction.");
    }

    let newStatus;

    if (action === "deposit_approve") {
      // === FIXED: 1 USDT = 100 Points ===
      await client.query(
        `INSERT INTO public.wallet_balances
          (user_id,balance,updated_at)
         VALUES ($1,$2::numeric,NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET
           balance = public.wallet_balances.balance + (EXCLUDED.balance * 100),
           updated_at = NOW()`,
        [tx.user_id, tx.amount]
      );

      newStatus = "confirmed";
    } else if (action === "deposit_reject") {
      newStatus = "rejected";
    } else if (action === "withdrawal_approve") {
      // The amount must already have been reserved by the
      // user-facing withdrawal request endpoint.
      newStatus = "confirmed";
    } else if (action === "withdrawal_reject") {
      // === FIXED: Refund 1 USDT = 100 Points ===
      await client.query(
        `INSERT INTO public.wallet_balances
          (user_id,balance,updated_at)
         VALUES ($1,$2::numeric,NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET
           balance = public.wallet_balances.balance + (EXCLUDED.balance * 100),
           updated_at = NOW()`,
        [tx.user_id, tx.amount]
      );

      newStatus = "rejected";
    } else {
      throw new Error("Unsupported wallet review action.");
    }

    if (action === "withdrawal_approve") {
      await client.query(
        `INSERT INTO public.user_notifications(user_id,kind,title,message)
         VALUES($1,'withdrawal','Withdrawal approved',$2)`,
        [tx.user_id, `Your withdrawal of ${Number(tx.amount).toFixed(2)} USDT was approved and is ready for payout.`]
      );
    }

    await client.query(
      `UPDATE public.transactions
SET status=$1,
  admin_note=$2,
  payout_tx_hash=CASE WHEN $5 <> '' THEN $5 ELSE payout_tx_hash END,
           reviewed_at=NOW(),
           reviewed_by=$3,
           updated_at=NOW()
       WHERE id=$4`,
      [
newStatus,
  reviewNote,
  session.username,
  transactionId,
  payoutTxHash
      ]
    );

    await client.query("COMMIT");

    if (action === "withdrawal_approve") {
      await notifyTelegram(`✅ Withdrawal approved\n👤 Name: ${tx.first_name || "User"}${tx.last_name ? ` ${tx.last_name}` : ""}\n💵 Amount: ${Number(tx.amount).toFixed(2)} USDT\n📣 Manual payout approved`, [process.env.ADMIN_CHAT_ID, RESULTS_CHANNEL]);
    } else if (action === "deposit_approve") {
      await notifyTelegram(`✅ Deposit approved\n👤 User ID: ${tx.telegram_id}\n💵 Amount credited: ${Number(tx.amount) * 100} points (${Number(tx.amount).toFixed(2)} USDT)`);
    }

    await audit(
      session.username,
      action,
      req,
      "success",
      "transaction",
      transactionId
    );

    return {
      ok: true,
      transaction_id: transactionId,
      transaction_type: tx.transaction_type,
      status: newStatus,
      message:
        action === "deposit_approve"
          ? `Deposit approved. ${Number(tx.amount) * 100} Points credited to user.`
          : action === "deposit_reject"
          ? "Deposit rejected."
          : action === "withdrawal_approve"
          ? "Withdrawal approved for manual payout."
          : "Withdrawal rejected and reserved balance refunded."
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/* =========================
   SECURITY SUMMARY
========================= */

async function securitySummary() {
  const [attempts, auditRows] = await Promise.all([
    query(`SELECT id,ip,success,attempted_at
      FROM public.admin_login_attempts
      ORDER BY attempted_at DESC
      LIMIT 100`),

    query(`SELECT id,created_at,admin_username,action,
      target_type,target_id,outcome,ip
      FROM public.admin_audit_log
      ORDER BY id DESC
      LIMIT 100`)
  ]);

  return {
    attempts,
    entries: auditRows
  };
}

/* =========================
   API HANDLER
========================= */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, {
      message: "Method not allowed."
    });
  }

  if (!validRequest(req)) {
    return json(res, 403, {
      message: "Request rejected."
    });
  }

  let settings;

  try {
    settings = getConfig();
  } catch {
    return json(res, 500, {
      message: "Admin configuration error. Check Vercel environment settings."
    });
  }

  const body = req.body || {};
  const action = String(body.action || "");

  if (action === "login") {
    try {
      if (!(await loginAllowed(req))) {
        await recordLogin(req, false);
        await audit(
          "unknown",
          "login_rate_limited",
          req,
          "blocked"
        );

        return json(res, 429, {
          message: "Too many login attempts. Try again in 15 minutes."
        });
      }

      const ok =
        safeEqual(body.username, settings.username) &&
        safeEqual(body.password, settings.password);

      await recordLogin(req, ok);

      if (!ok) {
        await audit("unknown", "login", req, "failed");

        return json(res, 401, {
          message: "Invalid username or password."
        });
      }

      setCookie(
        res,
        createSession(settings.username),
        SESSION_SECONDS
      );

      await audit(settings.username, "login", req);

      return json(res, 200, { ok: true });
    } catch (error) {
      console.error(
        "Admin login error:",
        error.code || error.name
      );

      return json(res, 500, {
        message: "Login service temporarily unavailable."
      });
    }
  }

  if (action === "logout") {
    setCookie(res, "", 0);
    return json(res, 200, { ok: true });
  }

  const session = verifySession(readCookie(req, COOKIE));

  if (!session) {
    return json(res, 401, {
      message: "Session expired. Please sign in again."
    });
  }

  try {
    let result;

    switch (action) {
      case "me":
        result = {
          ok: true,
          username: session.username
        };
        break;

      case "dashboard":
        result = await dashboard();
        break;

      case "analytics":
        result = await analytics();
        break;

      case "reconcile":
        result = await reconcile();
        break;

      case "users":
      case "wallets":
      case "transactions":
      case "rounds":
      case "bets":
      case "audit":
        result = await listAction(action, body);
        break;

      case "user_management":
        result = await userManagement(body, session, req);
        break;

      case "user_detail": {
        const id = String(body.user_id || "");

        if (!/^\d{1,15}$/.test(id)) {
          return json(res, 400, {
            message: "Invalid user ID."
          });
        }

        result = await userDetail(id);

        if (!result) {
          return json(res, 404, {
            message: "User not found."
          });
        }

        break;
      }

      case "deposit_addresses":
        result = await depositAddressConfig(body, session, req);
        break;

      case "search":
        result = await search(body.q);
        break;

      case "export":
        result = await exportCsv(body);
        break;

      case "security":
        result = await securitySummary();
        break;

      case "telegram":
        result = await telegramAdminAction(body, session, req);
        break;

      case "deposit_approve":
      case "deposit_reject":
      case "withdrawal_approve":
      case "withdrawal_reject":
        result = await reviewWalletTransaction(
          action,
          body,
          session,
          req
        );
        break;

      default:
        return json(res, 400, {
          message: "Unknown admin action."
        });
    }

    if (
      ![
        "deposit_approve",
        "deposit_reject",
        "withdrawal_approve",
        "withdrawal_reject"
      ].includes(action)
    ) {
      await audit(session.username, action, req);
    }

    return json(res, 200, result);
  } catch (error) {
    console.error(
      "Admin API error:",
      action,
      error.code || error.name || "Error"
    );

    let message = "Admin request failed. Check server logs.";

    if (error.code === "42P01") {
      message = "Required database table is missing.";
    } else if (error.code === "42703") {
      message = "Database column mismatch. Check actual table schema.";
    } else if (error.code === "22P02") {
      message = "Invalid database value.";
    } else if (
      error.message &&
      /Invalid |Unsupported |Transaction |This is not |Deposit approval is disabled/.test(
        error.message
      )
    ) {
      message = error.message;
    }

    return json(res, 400, { message });
  }
};
