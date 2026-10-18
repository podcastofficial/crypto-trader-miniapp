"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});

const COOKIE_NAME = "admin_session";
const SESSION_SECONDS = 2 * 60 * 60;
const MAX_PAGE_SIZE = 100;
const EXPORT_LIMIT = 5000;

const ALLOWED_STATUSES = new Set([
  "pending", "confirmed", "rejected", "completed",
  "failed", "open", "locked", "settled",
  "won", "lost", "cancelled"
]);

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));

  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function config() {
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
    throw new Error("Invalid admin environment configuration");
  }

  return { username, password, secret };
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
  const cookies = String(req.headers.cookie || "").split(";");

  for (const cookie of cookies) {
    const index = cookie.indexOf("=");

    if (index < 0) continue;

    if (cookie.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(cookie.slice(index + 1).trim());
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
      session.exp <= Math.floor(Date.now() / 1000) ||
      !safeEqual(session.username, process.env.ADMIN_USERNAME)
    ) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

function setSessionCookie(res, token, maxAge) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
  );
}

function validateRequest(req) {
  if (req.headers["x-admin-request"] !== "1") return false;

  const origin = req.headers.origin;

  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }

  return true;
}

function parsePage(body) {
  const page = Math.max(
    1,
    Math.min(1000000, Number.parseInt(body.page, 10) || 1)
  );

  const pageSize = Math.max(
    1,
    Math.min(MAX_PAGE_SIZE, Number.parseInt(body.page_size, 10) || 20)
  );

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize
  };
}

function numeric(value) {
  return Number(value || 0);
}

async function rows(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function audit(username, action, req, outcome = "success") {
  try {
    await pool.query(
      `INSERT INTO public.admin_audit_log
       (admin_username, action, outcome, ip, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [
        String(username || "unknown").slice(0, 200),
        String(action).slice(0, 100),
        String(outcome).slice(0, 50),
        String(req.headers["x-forwarded-for"] || "")
          .split(",")[0].trim().slice(0, 100)
      ]
    );
  } catch (error) {
    // Audit schema may differ; do not leak database details.
    console.error("Admin audit write failed:", error.code || error.name);
  }
}

/*
 * DASHBOARD
 */
async function dashboard() {
  const totals = await rows(`
    SELECT
      (SELECT COUNT(*) FROM public.users) AS users,
      (SELECT COUNT(*) FROM public.bets) AS bets,
      (SELECT COALESCE(SUM(stake), 0) FROM public.bets) AS total_stake,
      (SELECT COALESCE(SUM(fee), 0) FROM public.bets) AS total_fees,
      (SELECT COALESCE(SUM(payout), 0) FROM public.bets) AS total_payouts,
      (SELECT COALESCE(SUM(balance), 0) FROM public.wallets)
        AS total_wallet_balance,
      (SELECT COALESCE(SUM(amount), 0)
       FROM public.transactions
       WHERE transaction_type = 'deposit'
         AND status IN ('confirmed', 'completed'))
        AS total_deposits,
      (SELECT COUNT(*) FROM public.transactions
       WHERE transaction_type = 'deposit'
         AND status IN ('confirmed', 'completed'))
        AS deposit_count,
      (SELECT COALESCE(SUM(amount), 0)
       FROM public.transactions
       WHERE transaction_type = 'withdrawal'
         AND status IN ('confirmed', 'completed'))
        AS total_withdrawals,
      (SELECT COUNT(*) FROM public.transactions
       WHERE transaction_type = 'withdrawal'
         AND status IN ('confirmed', 'completed'))
        AS withdrawal_count
  `);

  const roundStatuses = await rows(`
    SELECT status, COUNT(*) AS count
    FROM public.game_rounds
    GROUP BY status
    ORDER BY status
  `);

  const recentRounds = await rows(`
    SELECT
      r.round_code,
      r.status,
      r.starts_at,
      r.betting_closes_at,
      r.ends_at,
      CASE WHEN r.ends_at <= NOW()
        THEN r.result_number ELSE NULL END AS result_number,
      COUNT(b.id) AS bet_count,
      COALESCE(SUM(b.stake), 0) AS total_stake,
      COALESCE(SUM(b.payout), 0) AS total_payout,
      COUNT(b.id) FILTER (
        WHERE b.status = 'pending'
      ) AS pending_bets,
      (
        r.status = 'settled'
        AND COUNT(b.id) FILTER (
          WHERE b.status = 'pending'
        ) = 0
      ) AS payout_complete
    FROM public.game_rounds r
    LEFT JOIN public.bets b
      ON b.round_code = r.round_code
    GROUP BY r.id
    ORDER BY r.starts_at DESC
    LIMIT 10
  `);

  const healthRows = await rows(`
    SELECT
      (SELECT COUNT(*) FROM public.game_rounds
       WHERE ends_at < NOW()
         AND status <> 'settled') AS overdue_rounds,
      (SELECT COUNT(*) FROM public.bets
       WHERE status = 'pending'
         AND created_at < NOW() - INTERVAL '10 minutes')
        AS old_pending_bets,
      (SELECT MAX(starts_at) FROM public.game_rounds)
        AS latest_round_start,
      (SELECT MAX(ends_at) FROM public.game_rounds
       WHERE status = 'settled') AS last_settled_at
  `);

  const health = healthRows[0] || {};

  return {
    totals: totals[0] || {},
    round_statuses: roundStatuses,
    recent_rounds: recentRounds,
    health: {
      database_ok: true,
      cron_ok:
        numeric(health.overdue_rounds) === 0 &&
        numeric(health.old_pending_bets) === 0,
      overdue_rounds: numeric(health.overdue_rounds),
      old_pending_bets: numeric(health.old_pending_bets),
      latest_round_start: health.latest_round_start,
      last_settled_at: health.last_settled_at
    }
  };
}

/*
 * PAGINATED READ-ONLY TABLES
 */
const LIST_CONFIG = {
  users: {
    table: "public.users",
    select: `
      id, telegram_id, username, balance,
      referred_by, referral_code, created_at
    `,
    order: "id DESC"
  },
  wallets: {
    table: "public.wallets",
    select: "user_id, balance, updated_at",
    order: "user_id DESC"
  },
  transactions: {
    table: "public.transactions",
    select: `
      id, user_id, transaction_type, amount, status,
      network, tx_hash, created_at, updated_at
    `,
    order: "id DESC"
  },
  rounds: {
    table: "public.game_rounds",
    select: `
      round_code, status, starts_at, betting_closes_at, ends_at,
      CASE WHEN ends_at <= NOW()
        THEN result_number ELSE NULL END AS result_number
    `,
    order: "starts_at DESC"
  },
  bets: {
    table: "public.bets",
    select: `
      id, user_id, round_code, bet_type, selection,
      stake, fee, status, result_number, payout,
      created_at, settled_at
    `,
    order: "id DESC"
  },
  audit: {
    table: "public.admin_audit_log",
    select: `
      id, created_at, admin_username, action,
      target_type, target_id, outcome, ip
    `,
    order: "id DESC"
  }
};

async function listAction(action, body) {
  const config = LIST_CONFIG[action];

  if (!config) throw new Error("Unsupported list action.");

  const { page, pageSize, offset } = parsePage(body);
  const conditions = [];
  const params = [];

  function add(sql, value) {
    params.push(value);
    conditions.push(sql.replace("?", `$${params.length}`));
  }

  if (action === "users") {
    if (body.q) {
      const query = String(body.q).trim().slice(0, 100);

      if (/^\d+$/.test(query)) {
        add("CAST(telegram_id AS TEXT) = ?", query);
      } else {
        add("username ILIKE ?", `%${query}%`);
      }
    }
  }

  if (action === "wallets" && body.q) {
    const query = String(body.q).trim().slice(0, 100);

    if (/^\d+$/.test(query)) {
      add("CAST(user_id AS TEXT) = ?", query);
    }
  }

  if (action === "transactions") {
    if (body.type) {
      const type = String(body.type);

      if (!["deposit", "withdrawal"].includes(type)) {
        throw new Error("Invalid transaction type.");
      }

      add("transaction_type = ?", type);
    }

    if (body.user_id) {
      if (!/^\d{1,15}$/.test(String(body.user_id))) {
        throw new Error("Invalid user ID.");
      }

      add("user_id = ?", String(body.user_id));
    }

    if (body.status) {
      const status = String(body.status);

      if (!ALLOWED_STATUSES.has(status)) {
        throw new Error("Invalid transaction status.");
      }

      add("status = ?", status);
    }
  }

  if (action === "bets") {
    if (body.user_id) {
      if (!/^\d{1,15}$/.test(String(body.user_id))) {
        throw new Error("Invalid user ID.");
      }

      add("user_id = ?", String(body.user_id));
    }

    if (body.round_code) {
      add("round_code = ?", String(body.round_code).slice(0, 100));
    }

    if (body.status) {
      const status = String(body.status);

      if (!ALLOWED_STATUSES.has(status)) {
        throw new Error("Invalid bet status.");
      }

      add("status = ?", status);
    }
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const count = await pool.query(
    `SELECT COUNT(*) AS total FROM ${config.table} ${where}`,
    params
  );

  const result = await pool.query(
    `SELECT ${config.select}
     FROM ${config.table}
     ${where}
     ORDER BY ${config.order}
     LIMIT $${params.length + 1}
     OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );

  const total = numeric(count.rows[0]?.total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    [action === "audit" ? "entries" : action]: result.rows,
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: totalPages,
      has_previous: page > 1,
      has_next: page < totalPages
    }
  };
}

/*
 * ANALYTICS
 */
async function analytics() {
  const daily = await rows(`
    WITH days AS (
      SELECT generate_series(
        CURRENT_DATE - INTERVAL '13 days',
        CURRENT_DATE,
        INTERVAL '1 day'
      )::date AS day
    )
    SELECT
      d.day,
      COUNT(b.id) AS bets,
      COALESCE(SUM(b.stake), 0) AS stake,
      COALESCE(SUM(b.payout), 0) AS payout,
      COALESCE(SUM(b.stake), 0)
        - COALESCE(SUM(b.payout), 0) AS net,
      COUNT(DISTINCT b.user_id) AS active_users,
      (
        SELECT COUNT(*)
        FROM public.users u
        WHERE u.created_at >= d.day
          AND u.created_at < d.day + INTERVAL '1 day'
      ) AS new_users
    FROM days d
    LEFT JOIN public.bets b
      ON b.created_at >= d.day
     AND b.created_at < d.day + INTERVAL '1 day'
    GROUP BY d.day
    ORDER BY d.day
  `);

  const results = await rows(`
    SELECT result_number, COUNT(*) AS count
    FROM public.game_rounds
    WHERE status = 'settled'
      AND result_number BETWEEN 0 AND 9
    GROUP BY result_number
    ORDER BY result_number
  `);

  const counts = Array(10).fill(0);

  for (const row of results) {
    counts[Number(row.result_number)] = numeric(row.count);
  }

  const totalRounds = counts.reduce((sum, value) => sum + value, 0);

  let verdict = "Not enough settled rounds for a useful statistical check";

  if (totalRounds >= 100) {
    verdict = "Distribution available; this is not proof of fairness";
  }

  const topUsers = await rows(`
    SELECT
      u.id,
      u.username,
      COUNT(b.id) AS bets,
      COALESCE(SUM(b.stake), 0) AS stake,
      COALESCE(SUM(b.payout), 0) AS payout,
      COALESCE(SUM(b.stake), 0)
        - COALESCE(SUM(b.payout), 0) AS user_net
    FROM public.users u
    JOIN public.bets b ON b.user_id = u.id
    GROUP BY u.id, u.username
    ORDER BY SUM(b.stake) DESC
    LIMIT 10
  `);

  const largeStakes = await rows(`
    SELECT id, user_id, round_code, bet_type, stake, created_at
    FROM public.bets
    ORDER BY stake DESC
    LIMIT 20
  `);

  const highReturnUsers = await rows(`
    SELECT
      user_id,
      COUNT(*) AS bets,
      COALESCE(SUM(stake), 0) AS stake,
      COALESCE(SUM(payout), 0) AS payout,
      ROUND(
        100.0 * COALESCE(SUM(payout), 0)
        / NULLIF(SUM(stake), 0), 2
      ) AS return_percent
    FROM public.bets
    GROUP BY user_id
    HAVING SUM(stake) > 0
    ORDER BY SUM(payout) / NULLIF(SUM(stake), 0) DESC
    LIMIT 10
  `);

  return {
    daily,
    fairness: {
      counts,
      total_rounds: totalRounds,
      verdict
    },
    top_users: topUsers,
    large_stakes: largeStakes,
    high_return_users: highReturnUsers
  };
}

/*
 * RECONCILIATION
 *
 * This is a preliminary ledger check, not a substitute for
 * reviewing every transaction type and wallet mutation.
 */
async function reconcile() {
  const totalsRows = await rows(`
    SELECT
      (SELECT COALESCE(SUM(balance), 0)
       FROM public.wallets) AS wallet_total,

      (SELECT COALESCE(SUM(
        CASE
          WHEN transaction_type IN ('deposit', 'referral_commission')
            AND status IN ('confirmed', 'completed')
            THEN amount
          WHEN transaction_type IN ('withdrawal', 'bet', 'payout')
            AND status IN ('confirmed', 'completed')
            THEN -amount
          ELSE 0
        END
      ), 0) FROM public.transactions) AS ledger_net,

      (SELECT COALESCE(SUM(stake), 0)
       FROM public.bets) AS bets_stake,

      (SELECT COALESCE(SUM(payout), 0)
       FROM public.bets WHERE status = 'won') AS bets_payout,

      (SELECT COUNT(*) FROM public.bets) AS bet_count,

      (SELECT COUNT(*) FROM public.transactions
       WHERE transaction_type = 'bet'
         AND status IN ('confirmed', 'completed')) AS bet_tx,

      (SELECT COUNT(*) FROM public.transactions
       WHERE transaction_type = 'payout'
         AND status IN ('confirmed', 'completed')) AS payout_tx,

      (SELECT COUNT(*) FROM public.bets
       WHERE status = 'won') AS paid_bets
  `);

  const totals = totalsRows[0] || {};

  const walletTotal = numeric(totals.wallet_total);
  const ledgerNet = numeric(totals.ledger_net);
  const betStake = numeric(totals.bets_stake);
  const betPayout = numeric(totals.bets_payout);

  const mismatches = [];

  const walletRows = await rows(`
    SELECT w.user_id, u.username, w.balance
    FROM public.wallets w
    LEFT JOIN public.users u ON u.id = w.user_id
    ORDER BY w.user_id
    LIMIT 100
  `);

  return {
    clean: false,
    totals: {
      wallet_total: walletTotal,
      ledger_net: ledgerNet,
      commissions: 0,
      unrecorded: Number((walletTotal - ledgerNet).toFixed(2)),
      bets_stake: betStake,
      bet_tx: numeric(totals.bet_tx),
      stake_diff: "Needs transaction-type and fee review",
      bets_payout: betPayout,
      payout_tx: numeric(totals.payout_tx),
      payout_diff: "Needs payout ledger review",
      bet_count_diff: numeric(totals.bet_count) - numeric(totals.bet_tx),
      payout_count_diff: numeric(totals.paid_bets) - numeric(totals.payout_tx)
    },
    mismatches,
    wallet_sample: walletRows
  };
}

/*
 * USER DETAILS
 */
async function userDetail(userId) {
  const profiles = await rows(`
    SELECT id, telegram_id, username, balance,
           referral_code, referred_by, created_at
    FROM public.users
    WHERE id = $1
    LIMIT 1
  `, [userId]);

  if (!profiles.length) return null;

  const stats = await rows(`
    SELECT
      COUNT(*) AS bets,
      COALESCE(SUM(stake), 0) AS stake,
      COALESCE(SUM(payout), 0) AS payout,
      COUNT(*) FILTER (WHERE status = 'won') AS wins,
      COUNT(*) FILTER (WHERE status = 'lost') AS losses
    FROM public.bets
    WHERE user_id = $1
  `, [userId]);

  const recentBets = await rows(`
    SELECT id, round_code, bet_type, selection, stake, fee,
           status, result_number, payout, created_at, settled_at
    FROM public.bets
    WHERE user_id = $1
    ORDER BY id DESC
    LIMIT 20
  `, [userId]);

  const recentTransactions = await rows(`
    SELECT id, transaction_type, amount, status,
           network, tx_hash, created_at
    FROM public.transactions
    WHERE user_id = $1
    ORDER BY id DESC
    LIMIT 20
  `, [userId]);

  return {
    profile: profiles[0],
    stats: stats[0] || {},
    recent_bets: recentBets,
    recent_transactions: recentTransactions,
    referral_tree: [],
    commissions_earned: [],
    commissions_generated: 0
  };
}

/*
 * GLOBAL SEARCH
 */
async function search(query) {
  const q = String(query || "").trim().slice(0, 100);

  if (!q) {
    return { users: [], rounds: [], bets: [] };
  }

  const users = await rows(`
    SELECT id, telegram_id, username, balance
    FROM public.users
    WHERE CAST(id AS TEXT) = $1
       OR CAST(telegram_id AS TEXT) = $1
       OR username ILIKE $2
    ORDER BY id DESC
    LIMIT 20
  `, [q, `%${q}%`]);

  const rounds = await rows(`
    SELECT round_code, status, starts_at, ends_at
    FROM public.game_rounds
    WHERE round_code = $1
    ORDER BY starts_at DESC
    LIMIT 10
  `, [q]);

  const bets = /^\d+$/.test(q)
    ? await rows(`
        SELECT id, user_id, round_code, bet_type, stake, status
        FROM public.bets
        WHERE id = $1
        LIMIT 10
      `, [q])
    : [];

  return { users, rounds, bets };
}

/*
 * CSV EXPORT
 */
async function exportCsv(body) {
  const kind = String(body.kind || "");

  const exports = {
    users: `
      SELECT id, telegram_id, username, balance, created_at
      FROM public.users ORDER BY id DESC LIMIT ${EXPORT_LIMIT}
    `,
    bets: `
      SELECT id, user_id, round_code, bet_type, selection,
             stake, fee, status, result_number, payout, created_at
      FROM public.bets ORDER BY id DESC LIMIT ${EXPORT_LIMIT}
    `,
    transactions: `
      SELECT id, user_id, transaction_type, amount, status,
             network, tx_hash, created_at
      FROM public.transactions
      ORDER BY id DESC LIMIT ${EXPORT_LIMIT}
    `
  };

  if (!exports[kind]) {
    throw new Error("Unsupported export type.");
  }

  const data = await rows(exports[kind]);
  const columns = data.length ? Object.keys(data[0]) : [];

  function cell(value) {
    let text = value == null ? "" : String(value);

    // Prevent spreadsheet formula injection.
    if (/^[\s]*[=+\-@\t\r]/.test(text)) {
      text = "'" + text;
    }

    return `"${text.replace(/"/g, '""')}"`;
  }

  const csv = [
    columns.map(cell).join(","),
    ...data.map(row =>
      columns.map(column => cell(row[column])).join(",")
    )
  ].join("\r\n");

  return {
    csv,
    row_count: data.length,
    truncated: data.length === EXPORT_LIMIT
  };
}

/*
 * MAIN API HANDLER
 */
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { message: "Method not allowed." });
  }

  if (!validateRequest(req)) {
    return send(res, 403, { message: "Request rejected." });
  }

  let settings;

  try {
    settings = config();
  } catch {
    return send(res, 500, {
      message: "Admin configuration error. Check Vercel environment variables."
    });
  }

  const body = req.body || {};
  const action = String(body.action || "");

  if (action === "login") {
    const username = String(body.username || "");
    const password = String(body.password || "");

    if (
      !safeEqual(username, settings.username) ||
      !safeEqual(password, settings.password)
    ) {
      await audit("unknown", "login", req, "failed");

      return send(res, 401, {
        message: "Invalid username or password."
      });
    }

    setSessionCookie(res, createSession(username), SESSION_SECONDS);
    await audit(username, "login", req);

    return send(res, 200, { ok: true });
  }

  if (action === "logout") {
    setSessionCookie(res, "", 0);
    return send(res, 200, { ok: true });
  }

  const session = verifySession(readCookie(req, COOKIE_NAME));

  if (!session) {
    return send(res, 401, {
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

      case "user_detail": {
        const userId = String(body.user_id || "");

        if (!/^\d{1,15}$/.test(userId)) {
          return send(res, 400, { message: "Invalid user ID." });
        }

        result = await userDetail(userId);

        if (!result) {
          return send(res, 404, { message: "User not found." });
        }

        break;
      }

      case "search":
        result = await search(body.q);
        break;

      case "export":
        result = await exportCsv(body);
        break;

      default:
        return send(res, 400, {
          message: "Unknown admin action."
        });
    }

    await audit(session.username, action, req);

    return send(res, 200, result);

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
      message = "A database column does not match the admin code.";
    } else if (error.code === "22P02") {
      message = "Invalid database value.";
    }

    return send(res, 500, { message });
  }
};