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

const COOKIE = "admin_session";
const SESSION_SECONDS = 7200;
const PAGE_SIZE_MAX = 100;
const EXPORT_MAX = 5000;

const STATUSES = new Set([
  "pending", "confirmed", "rejected", "completed", "failed",
  "open", "locked", "settled", "won", "lost", "cancelled"
]);

function json(res, status, data) {
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

function getConfig() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;

  if (!username || !password || password.length < 12 ||
      !secret || secret.length < 32) {
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
    ) return null;

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
    console.error("Admin audit write failed:", error.code || error.name);
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

  return { page, size, offset: (page - 1) * size };
}

/*
 * DASHBOARD
 * Uses actual wallet_balances table.
 */
async function dashboard() {
  const totals = await query(`
    SELECT
      (SELECT COUNT(*) FROM public.users) AS users,
      (SELECT COUNT(*) FROM public.bets) AS bets,
      (SELECT COALESCE(SUM(stake), 0) FROM public.bets) AS total_stake,
      (SELECT COALESCE(SUM(fee), 0) FROM public.bets) AS total_fees,
      (SELECT COALESCE(SUM(payout), 0) FROM public.bets) AS total_payouts,
      (SELECT COALESCE(SUM(balance), 0)
       FROM public.wallet_balances) AS total_wallet_balance,
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
       AS withdrawal_count,
      (SELECT COALESCE(SUM(commission_amount), 0)
       FROM public.referral_commissions) AS total_commissions
  `);

  const roundStatuses = await query(`
    SELECT status, COUNT(*) AS count
    FROM public.game_rounds
    GROUP BY status
    ORDER BY status
  `);

  const recentRounds = await query(`
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
      COUNT(b.id) FILTER (WHERE b.status = 'pending') AS pending_bets,
      (
        r.status = 'settled'
        AND COUNT(b.id) FILTER (WHERE b.status = 'pending') = 0
      ) AS payout_complete
    FROM public.game_rounds r
    LEFT JOIN public.bets b ON b.round_id = r.id
    GROUP BY r.id
    ORDER BY r.starts_at DESC
    LIMIT 10
  `);

  const healthRows = await query(`
    SELECT
      (SELECT COUNT(*) FROM public.game_rounds
       WHERE ends_at < NOW() AND status <> 'settled')
       AS overdue_rounds,
      (SELECT COUNT(*) FROM public.bets
       WHERE status = 'pending'
         AND created_at < NOW() - INTERVAL '10 minutes')
       AS old_pending_bets,
      (SELECT MAX(starts_at) FROM public.game_rounds)
       AS latest_round_start,
      (SELECT MAX(settled_at) FROM public.game_rounds
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
 * READ-ONLY LISTS
 */
const LISTS = {
  users: {
    table: "public.users",
    select: `u.id, u.telegram_id, u.username, w.balance,
      u.referred_by, u.referral_code, u.created_at,
      (SELECT COUNT(*) FROM public.users child
       WHERE child.referred_by = u.id) AS referral_count`,
    from: `public.users u
      LEFT JOIN public.wallet_balances w ON w.user_id = u.id`,
    order: "u.id DESC"
  },
  wallets: {
    table: "public.wallet_balances",
    select: `w.user_id, u.telegram_id, u.username,
      w.balance, w.updated_at`,
    from: `public.wallet_balances w
      LEFT JOIN public.users u ON u.id = w.user_id`,
    order: "w.user_id DESC"
  },
  transactions: {
    table: "public.transactions",
    select: `id, user_id, transaction_type, amount, status,
      network, tx_hash, created_at, updated_at`,
    from: "public.transactions",
    order: "id DESC"
  },
  rounds: {
    table: "public.game_rounds",
    select: `round_code, status, starts_at, betting_closes_at,
      ends_at, CASE WHEN ends_at <= NOW()
      THEN result_number ELSE NULL END AS result_number`,
    from: "public.game_rounds",
    order: "starts_at DESC"
  },
  bets: {
    table: "public.bets",
    select: `b.id, b.user_id, b.round_id, r.round_code,
      b.bet_type, b.selection, b.stake, b.fee, b.status,
      CASE WHEN r.ends_at <= NOW()
        THEN r.result_number ELSE NULL END AS result_number,
      b.payout, b.created_at, b.settled_at`,
    from: `public.bets b
      LEFT JOIN public.game_rounds r ON r.id = b.round_id`,
    order: "b.id DESC"
  },
  audit: {
    table: "public.admin_audit_log",
    select: `id, created_at, admin_username, action,
      target_type, target_id, outcome, ip`,
    from: "public.admin_audit_log",
    order: "id DESC"
  }
};

async function listAction(action, body) {
  const cfg = LISTS[action];
  if (!cfg) throw new Error("Unsupported list action.");

  const { page, size, offset } = pagination(body);
  const conditions = [];
  const params = [];

  function add(condition, value) {
    params.push(value);
    conditions.push(condition.replace("?", `$${params.length}`));
  }

  if (action === "users" && body.q) {
    const q = String(body.q).trim().slice(0, 100);

    if (/^\d+$/.test(q)) {
      add("CAST(u.telegram_id AS TEXT) = ?", q);
    } else {
      add("u.username ILIKE ?", `%${q}%`);
    }
  }

  if (action === "wallets" && body.q) {
    const q = String(body.q).trim().slice(0, 100);

    if (/^\d+$/.test(q)) {
      add("CAST(w.user_id AS TEXT) = ?", q);
    } else {
      add("u.username ILIKE ?", `%${q}%`);
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
      if (!STATUSES.has(status)) throw new Error("Invalid status.");
      add("status = ?", status);
    }
  }

  if (action === "bets") {
    if (body.user_id) {
      if (!/^\d{1,15}$/.test(String(body.user_id))) {
        throw new Error("Invalid user ID.");
      }
      add("b.user_id = ?", String(body.user_id));
    }

    if (body.round_code) {
      add("r.round_code = ?", String(body.round_code).slice(0, 100));
    }

    if (body.status) {
      const status = String(body.status);
      if (!STATUSES.has(status)) throw new Error("Invalid status.");
      add("b.status = ?", status);
    }
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const countRows = await query(
    `SELECT COUNT(*) AS total FROM ${cfg.from} ${where}`,
    params
  );

  const resultRows = await query(
    `SELECT ${cfg.select}
     FROM ${cfg.from}
     ${where}
     ORDER BY ${cfg.order}
     LIMIT $${params.length + 1}
     OFFSET $${params.length + 2}`,
    [...params, size, offset]
  );

  const total = Number(countRows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / size));

  return {
    [action === "audit" ? "entries" : action]: resultRows,
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

/*
 * ANALYTICS
 */
async function analytics() {
  const daily = await query(`
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
      COALESCE(SUM(b.stake), 0) -
        COALESCE(SUM(b.payout), 0) AS net,
      COUNT(DISTINCT b.user_id) AS active_users,
      (SELECT COUNT(*) FROM public.users u
       WHERE u.created_at >= d.day
         AND u.created_at < d.day + INTERVAL '1 day') AS new_users
    FROM days d
    LEFT JOIN public.bets b
      ON b.created_at >= d.day
     AND b.created_at < d.day + INTERVAL '1 day'
    GROUP BY d.day
    ORDER BY d.day
  `);

  const resultRows = await query(`
    SELECT result_number, COUNT(*) AS count
    FROM public.game_rounds
    WHERE status = 'settled'
      AND result_number BETWEEN 0 AND 9
    GROUP BY result_number
    ORDER BY result_number
  `);

  const counts = Array(10).fill(0);

  for (const row of resultRows) {
    counts[Number(row.result_number)] = Number(row.count);
  }

  const totalRounds = counts.reduce((a, b) => a + b, 0);

  const topUsers = await query(`
    SELECT u.id, u.username, COUNT(b.id) AS bets,
      COALESCE(SUM(b.stake), 0) AS stake,
      COALESCE(SUM(b.payout), 0) AS payout,
      COALESCE(SUM(b.stake), 0) -
        COALESCE(SUM(b.payout), 0) AS user_net
    FROM public.users u
    JOIN public.bets b ON b.user_id = u.id
    GROUP BY u.id, u.username
    ORDER BY SUM(b.stake) DESC
    LIMIT 10
  `);

  const largeStakes = await query(`
    SELECT b.id, b.user_id, r.round_code,
      b.bet_type, b.stake, b.created_at
    FROM public.bets b
    LEFT JOIN public.game_rounds r ON r.id = b.round_id
    ORDER BY b.stake DESC
    LIMIT 20
  `);

  const highReturnUsers = await query(`
    SELECT user_id, COUNT(*) AS bets,
      COALESCE(SUM(stake), 0) AS stake,
      COALESCE(SUM(payout), 0) AS payout,
      ROUND(100.0 * COALESCE(SUM(payout), 0)
        / NULLIF(SUM(stake), 0), 2) AS return_percent
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
      verdict: totalRounds < 100
        ? "Not enough settled rounds for a useful statistical check"
        : "Distribution available; not proof of fairness"
    },
    top_users: topUsers,
    large_stakes: largeStakes,
    high_return_users: highReturnUsers
  };
}

/*
 * RECONCILIATION
 *
 * No clean=true claim is made until the complete accounting
 * semantics of every transaction type have been verified.
 */
async function reconcile() {
  const totalsRows = await query(`
    SELECT
      (SELECT COALESCE(SUM(balance), 0)
       FROM public.wallet_balances) AS wallet_total,

      (SELECT COALESCE(SUM(commission_amount), 0)
       FROM public.referral_commissions) AS commissions,

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

  const t = totalsRows[0] || {};

  const walletTotal = Number(t.wallet_total || 0);
  const commissions = Number(t.commissions || 0);

  return {
    clean: false,
    totals: {
      wallet_total: walletTotal,
      ledger_net: 0,
      commissions,
      unrecorded: "Requires full ledger mapping",
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

/*
 * USER DETAIL
 */
async function userDetail(userId) {
  const profiles = await query(`
    SELECT u.id, u.telegram_id, u.username,
      w.balance, u.referral_code, u.referred_by, u.created_at
    FROM public.users u
    LEFT JOIN public.wallet_balances w ON w.user_id = u.id
    WHERE u.id = $1
    LIMIT 1
  `, [userId]);

  if (!profiles.length) return null;

  const stats = await query(`
    SELECT COUNT(*) AS bets,
      COALESCE(SUM(stake), 0) AS stake,
      COALESCE(SUM(payout), 0) AS payout,
      COUNT(*) FILTER (WHERE status = 'won') AS wins,
      COUNT(*) FILTER (WHERE status = 'lost') AS losses
    FROM public.bets WHERE user_id = $1
  `, [userId]);

  const recentBets = await query(`
    SELECT b.id, r.round_code, b.bet_type, b.selection,
      b.stake, b.fee, b.status,
      CASE WHEN r.ends_at <= NOW()
        THEN r.result_number ELSE NULL END AS result_number,
      b.payout, b.created_at, b.settled_at
    FROM public.bets b
    LEFT JOIN public.game_rounds r ON r.id = b.round_id
    WHERE b.user_id = $1
    ORDER BY b.id DESC
    LIMIT 20
  `, [userId]);

  const recentTransactions = await query(`
    SELECT id, transaction_type, amount, status,
      network, tx_hash, created_at
    FROM public.transactions
    WHERE user_id = $1
    ORDER BY id DESC
    LIMIT 20
  `, [userId]);

  const commissions = await query(`
    SELECT referral_level, COUNT(*) AS count,
      COALESCE(SUM(commission_amount), 0) AS total
    FROM public.referral_commissions
    WHERE referrer_user_id = $1
    GROUP BY referral_level
    ORDER BY referral_level
  `, [userId]);

  const referralTree = await query(`
    WITH RECURSIVE referral_tree AS (
      SELECT id, username, referred_by, created_at, 1 AS level
      FROM public.users
      WHERE referred_by = $1

      UNION ALL

      SELECT u.id, u.username, u.referred_by, u.created_at,
        rt.level + 1
      FROM public.users u
      JOIN referral_tree rt ON u.referred_by = rt.id
      WHERE rt.level < 3
    )
    SELECT id, username, referred_by, created_at, level
    FROM referral_tree
    ORDER BY level, id
    LIMIT 200
  `, [userId]);

  const generated = await query(`
    SELECT COALESCE(SUM(commission_amount), 0) AS total
    FROM public.referral_commissions
    WHERE source_user_id = $1
  `, [userId]);

  return {
    profile: profiles[0],
    stats: stats[0] || {},
    recent_bets: recentBets,
    recent_transactions: recentTransactions,
    referral_tree: referralTree,
    commissions_earned: commissions,
    commissions_generated: Number(generated[0]?.total || 0)
  };
}

/*
 * SEARCH
 */
async function search(q) {
  q = String(q || "").trim().slice(0, 100);

  if (!q) return { users: [], rounds: [], bets: [] };

  const users = await query(`
    SELECT u.id, u.telegram_id, u.username, w.balance
    FROM public.users u
    LEFT JOIN public.wallet_balances w ON w.user_id = u.id
    WHERE CAST(u.id AS TEXT) = $1
       OR CAST(u.telegram_id AS TEXT) = $1
       OR u.username ILIKE $2
    ORDER BY u.id DESC
    LIMIT 20
  `, [q, `%${q}%`]);

  const rounds = await query(`
    SELECT round_code, status, starts_at, ends_at
    FROM public.game_rounds
    WHERE round_code = $1
    ORDER BY starts_at DESC
    LIMIT 10
  `, [q]);

  const bets = /^\d+$/.test(q)
    ? await query(`
        SELECT b.id, b.user_id, r.round_code,
          b.bet_type, b.stake, b.status
        FROM public.bets b
        LEFT JOIN public.game_rounds r ON r.id = b.round_id
        WHERE b.id = $1
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

  const exportQueries = {
    users: `
      SELECT u.id, u.telegram_id, u.username,
        w.balance, u.created_at
      FROM public.users u
      LEFT JOIN public.wallet_balances w ON w.user_id = u.id
      ORDER BY u.id DESC LIMIT ${EXPORT_MAX}
    `,
    bets: `
      SELECT b.id, b.user_id, r.round_code,
        b.bet_type, b.selection, b.stake, b.fee,
        b.status, b.payout, b.created_at
      FROM public.bets b
      LEFT JOIN public.game_rounds r ON r.id = b.round_id
      ORDER BY b.id DESC LIMIT ${EXPORT_MAX}
    `,
    transactions: `
      SELECT id, user_id, transaction_type, amount,
        status, network, tx_hash, created_at
      FROM public.transactions
      ORDER BY id DESC LIMIT ${EXPORT_MAX}
    `
  };

  if (!exportQueries[kind]) {
    throw new Error("Invalid export type.");
  }

  const data = await query(exportQueries[kind]);
  const columns = data.length ? Object.keys(data[0]) : [];

  function cell(value) {
    let text = value == null ? "" : String(value);

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
    truncated: data.length === EXPORT_MAX
  };
}

/*
 * MAIN HANDLER
 */
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { message: "Method not allowed." });
  }

  if (!validRequest(req)) {
    return json(res, 403, { message: "Request rejected." });
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
    const username = String(body.username || "");
    const password = String(body.password || "");

    if (
      !safeEqual(username, settings.username) ||
      !safeEqual(password, settings.password)
    ) {
      await audit("unknown", "login", req, "failed");

      return json(res, 401, {
        message: "Invalid username or password."
      });
    }

    setCookie(res, createSession(username), SESSION_SECONDS);
    await audit(username, "login", req);

    return json(res, 200, { ok: true });
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
        result = { ok: true, username: session.username };
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
        const id = String(body.user_id || "");

        if (!/^\d{1,15}$/.test(id)) {
          return json(res, 400, { message: "Invalid user ID." });
        }

        result = await userDetail(id);

        if (!result) {
          return json(res, 404, { message: "User not found." });
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
        return json(res, 400, { message: "Unknown admin action." });
    }

    await audit(session.username, action, req);
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
    }

    return json(res, 500, { message });
  }
};