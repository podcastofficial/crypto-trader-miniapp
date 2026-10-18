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

pool.on("error", error => {
  console.error("Admin DB pool error:", error.code || error.name);
});

const COOKIE = "admin_session";
const SESSION_SECONDS = 7200;
const PAGE_SIZE_MAX = 100;
const EXPORT_MAX = 5000;

const STATUSES = new Set([
  "pending",
  "confirmed",
  "rejected",
  "completed",
  "failed",
  "open",
  "locked",
  "settled",
  "won",
  "lost",
  "cancelled"
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
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(data));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));

  return (
    x.length === y.length &&
    crypto.timingSafeEqual(x, y)
  );
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
    throw new Error(
      "Admin environment configuration is invalid."
    );
  }

  return { username, password };
}

function sign(value) {
  return crypto
    .createHmac(
      "sha256",
      process.env.ADMIN_SESSION_SECRET
    )
    .update(value)
    .digest("base64url");
}

function createSession(username) {
  const payload = Buffer.from(
    JSON.stringify({
      username,
      exp:
        Math.floor(Date.now() / 1000) +
        SESSION_SECONDS,
      nonce: crypto.randomBytes(16).toString("hex")
    })
  ).toString("base64url");

  return `${payload}.${sign(payload)}`;
}

function readCookie(req, name) {
  const cookies = String(
    req.headers.cookie || ""
  ).split(";");

  for (const item of cookies) {
    const index = item.indexOf("=");

    if (index < 0) continue;

    if (item.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(
          item.slice(index + 1).trim()
        );
      } catch {
        return "";
      }
    }
  }

  return "";
}

function verifySession(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 2) return null;

  const [payload, signature] = parts;

  if (!safeEqual(signature, sign(payload))) {
    return null;
  }

  try {
    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (
      !session.username ||
      !Number.isFinite(session.exp) ||
      session.exp <= Date.now() / 1000 ||
      !safeEqual(
        session.username,
        process.env.ADMIN_USERNAME
      )
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
    `${COOKIE}=${encodeURIComponent(value)}; ` +
    `Path=/api/admin; HttpOnly; Secure; ` +
    `SameSite=Strict; Max-Age=${maxAge}`
  );
}

function validRequest(req) {
  if (req.headers["x-admin-request"] !== "1") {
    return false;
  }

  if (req.headers.origin) {
    try {
      if (
        new URL(req.headers.origin).host !==
        req.headers.host
      ) {
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
  )
    .split(",")[0]
    .trim()
    .slice(0, 100);
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
       (
         admin_username,
         action,
         target_type,
         target_id,
         outcome,
         ip,
         created_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
      [
        String(username || "unknown").slice(0, 200),
        String(action).slice(0, 100),
        targetType
          ? String(targetType).slice(0, 100)
          : null,
        targetId == null
          ? null
          : String(targetId).slice(0, 100),
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

  const ipRows = await query(
    `SELECT COUNT(*) AS failed_ip
     FROM public.admin_login_attempts
     WHERE ip = $1
       AND success = FALSE
       AND attempted_at >
           NOW() - INTERVAL '15 minutes'`,
    [ip]
  );

  const globalRows = await query(
    `SELECT COUNT(*) AS failed_global
     FROM public.admin_login_attempts
     WHERE success = FALSE
       AND attempted_at >
           NOW() - INTERVAL '15 minutes'`
  );

  return (
    Number(ipRows[0]?.failed_ip || 0) < 5 &&
    Number(globalRows[0]?.failed_global || 0) < 30
  );
}

async function recordLogin(req, success) {
  await pool.query(
    `INSERT INTO public.admin_login_attempts
     (ip, success, attempted_at)
     VALUES ($1,$2,NOW())`,
    [ipAddress(req), Boolean(success)]
  );
}

function pagination(body) {
  const page = Math.max(
    1,
    Math.min(
      1000000,
      Number.parseInt(body.page, 10) || 1
    )
  );

  const size = Math.max(
    1,
    Math.min(
      PAGE_SIZE_MAX,
      Number.parseInt(body.page_size, 10) || 20
    )
  );

  return {
    page,
    size,
    offset: (page - 1) * size
  };
}

/*
 * USER SEGMENTS
 *
 * Activity is based on recorded bets.
 * It does not measure app opens or logins.
 */

function userSegmentSql(segment) {
  switch (segment) {
    case "new_today":
      return `u.created_at >= CURRENT_DATE
        AND u.created_at <
            CURRENT_DATE + INTERVAL '1 day'`;

    case "new_7d":
      return `u.created_at >=
        NOW() - INTERVAL '7 days'`;

    case "active_24h":
      return `EXISTS (
        SELECT 1
        FROM public.bets b
        WHERE b.user_id = u.id
          AND b.created_at >=
              NOW() - INTERVAL '24 hours'
      )`;

    case "active_7d":
      return `EXISTS (
        SELECT 1
        FROM public.bets b
        WHERE b.user_id = u.id
          AND b.created_at >=
              NOW() - INTERVAL '7 days'
      )`;

    case "inactive_30d":
      return `NOT EXISTS (
        SELECT 1
        FROM public.bets b
        WHERE b.user_id = u.id
          AND b.created_at >=
              NOW() - INTERVAL '30 days'
      )`;

    case "all":
    case "":
    case undefined:
      return "";

    default:
      throw new Error("Invalid user segment.");
  }
}
/*
 * DASHBOARD
 */

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
         FROM public.referral_commissions)
          AS total_commissions
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
          WHEN r.ends_at <= NOW()
          THEN r.result_number
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
         WHERE created_at>=CURRENT_DATE
           AND created_at<CURRENT_DATE+INTERVAL '1 day')
          AS new_today,
        (SELECT COUNT(*)
         FROM public.users
         WHERE created_at>=NOW()-INTERVAL '7 days')
          AS new_7d,
        (SELECT COUNT(DISTINCT user_id)
         FROM public.bets
         WHERE created_at>=NOW()-INTERVAL '24 hours')
          AS active_24h,
        (SELECT COUNT(DISTINCT user_id)
         FROM public.bets
         WHERE created_at>=NOW()-INTERVAL '7 days')
          AS active_7d,
        (SELECT COUNT(*)
         FROM public.users u
         WHERE NOT EXISTS (
           SELECT 1
           FROM public.bets b
           WHERE b.user_id=u.id
             AND b.created_at>=NOW()-INTERVAL '30 days'
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
 * READ-ONLY LIST CONFIGURATION
 */

const LISTS = {
  users: {
    select: `u.id, u.telegram_id, u.username,
      w.balance, u.referred_by, u.referral_code,
      u.created_at,
      (SELECT COUNT(*)
       FROM public.users child
       WHERE child.referred_by=u.id) AS referral_count`,
    from: `public.users u
      LEFT JOIN public.wallet_balances w
        ON w.user_id=u.id`,
    order: "u.id DESC"
  },

  wallets: {
    select: `w.user_id, u.telegram_id,
      u.username, w.balance, w.updated_at`,
    from: `public.wallet_balances w
      LEFT JOIN public.users u ON u.id=w.user_id`,
    order: "w.user_id DESC"
  },

  transactions: {
    select: `id, user_id, transaction_type,
      amount, status, network, tx_hash,
      created_at, updated_at`,
    from: "public.transactions",
    order: "id DESC"
  },

  rounds: {
    select: `r.id, r.round_code, r.status,
      r.starts_at, r.betting_closes_at, r.ends_at,
      CASE WHEN r.ends_at<=NOW()
        THEN r.result_number ELSE NULL
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
      ) AS payout_complete`,
    from: `public.game_rounds r
      LEFT JOIN public.bets b ON b.round_id=r.id`,
    group: "GROUP BY r.id",
    order: "r.starts_at DESC"
  },

  bets: {
    select: `b.id, b.user_id, b.round_id,
      r.round_code, b.bet_type, b.selection,
      b.stake, b.fee, b.status,
      CASE WHEN r.ends_at<=NOW()
        THEN r.result_number ELSE NULL
      END AS result_number,
      b.payout, b.created_at, b.settled_at`,
    from: `public.bets b
      LEFT JOIN public.game_rounds r ON r.id=b.round_id`,
    order: "b.id DESC"
  },

  audit: {
    select: `id, created_at, admin_username,
      action, target_type, target_id, outcome, ip`,
    from: "public.admin_audit_log",
    order: "id DESC"
  }
};

/*
 * SAFE FILTERED LISTS
 */

async function listAction(action, body) {
  const cfg = LISTS[action];

  if (!cfg) {
    throw new Error("Unsupported list action.");
  }

  const { page, size, offset } = pagination(body);
  const conditions = [];
  const params = [];

  function add(condition, value) {
    params.push(value);
    conditions.push(
      condition.replace("?", `$${params.length}`)
    );
  }

  if (action === "users") {
    const segment = String(body.segment || "all");

    if (!USER_SEGMENTS.has(segment)) {
      throw new Error("Invalid user segment.");
    }

    const segmentSql = userSegmentSql(segment);

    if (segmentSql) {
      conditions.push(`(${segmentSql})`);
    }

    if (body.q) {
      const q = String(body.q).trim().slice(0, 100);

      if (/^\d+$/.test(q)) {
        add(
          `(CAST(u.telegram_id AS TEXT)=?
            OR CAST(u.id AS TEXT)=?)`,
          q
        );

        // The second placeholder needs its own parameter.
        params.push(q);
        conditions[conditions.length - 1] =
          `(CAST(u.telegram_id AS TEXT)=$${params.length - 1}
            OR CAST(u.id AS TEXT)=$${params.length})`;
      } else {
        add("u.username ILIKE ?", `%${q}%`);
      }
    }
  }

  if (action === "wallets" && body.q) {
    const q = String(body.q).trim().slice(0, 100);

    if (/^\d+$/.test(q)) {
      add("CAST(w.user_id AS TEXT)=?", q);
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

      add("transaction_type=?", type);
    }

    if (body.user_id) {
      if (!/^\d{1,15}$/.test(String(body.user_id))) {
        throw new Error("Invalid user ID.");
      }

      add("user_id=?", String(body.user_id));
    }

    if (body.status) {
      const status = String(body.status);

      if (!STATUSES.has(status)) {
        throw new Error("Invalid status.");
      }

      add("status=?", status);
    }
  }

  if (action === "bets") {
    if (body.user_id) {
      if (!/^\d{1,15}$/.test(String(body.user_id))) {
        throw new Error("Invalid user ID.");
      }

      add("b.user_id=?", String(body.user_id));
    }

    if (body.round_code) {
      add(
        "r.round_code=?",
        String(body.round_code).slice(0, 100)
      );
    }

    if (body.status) {
      const status = String(body.status);

      if (!STATUSES.has(status)) {
        throw new Error("Invalid status.");
      }

      add("b.status=?", status);
    }
  }

  if (action === "audit" && body.q) {
    const q = String(body.q).trim().slice(0, 100);
    add("admin_username ILIKE ?", `%${q}%`);
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const group = cfg.group || "";

  const countRows = await query(
    `SELECT COUNT(*) AS total
     FROM (
       SELECT 1
       FROM ${cfg.from}
       ${where}
       ${group}
     ) filtered_records`,
    params
  );

  const resultRows = await query(
    `SELECT ${cfg.select}
     FROM ${cfg.from}
     ${where}
     ${group}
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
      COALESCE(SUM(b.stake),0) AS stake,
      COALESCE(SUM(b.payout),0) AS payout,
      COALESCE(SUM(b.stake),0)
        - COALESCE(SUM(b.payout),0) AS net,
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

  const resultRows = await query(`
    SELECT result_number, COUNT(*) AS count
    FROM public.game_rounds
    WHERE status='settled'
      AND result_number BETWEEN 0 AND 9
    GROUP BY result_number
    ORDER BY result_number
  `);

  const counts = Array(10).fill(0);

  for (const row of resultRows) {
    counts[Number(row.result_number)] = Number(row.count);
  }

  const totalRounds = counts.reduce(
    (sum, count) => sum + count,
    0
  );

  const topUsers = await query(`
    SELECT
      u.id,
      u.username,
      COUNT(b.id) AS bets,
      COALESCE(SUM(b.stake),0) AS stake,
      COALESCE(SUM(b.payout),0) AS payout,
      COALESCE(SUM(b.stake),0)
        - COALESCE(SUM(b.payout),0) AS user_net
    FROM public.users u
    JOIN public.bets b ON b.user_id=u.id
    GROUP BY u.id, u.username
    ORDER BY SUM(b.stake) DESC
    LIMIT 10
  `);

  const largeStakes = await query(`
    SELECT
      b.id,
      b.user_id,
      r.round_code,
      b.bet_type,
      b.stake,
      b.created_at
    FROM public.bets b
    LEFT JOIN public.game_rounds r ON r.id=b.round_id
    ORDER BY b.stake DESC
    LIMIT 20
  `);

  const highReturnUsers = await query(`
    SELECT
      user_id,
      COUNT(*) AS bets,
      COALESCE(SUM(stake),0) AS stake,
      COALESCE(SUM(payout),0) AS payout,
      ROUND(
        100.0 * COALESCE(SUM(payout),0)
        / NULLIF(SUM(stake),0),
        2
      ) AS return_percent
    FROM public.bets
    GROUP BY user_id
    HAVING SUM(stake)>0
    ORDER BY
      SUM(payout)/NULLIF(SUM(stake),0) DESC
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
 * This reports available totals but does not claim
 * that the financial ledger is fully reconciled.
 */

async function reconcile() {
  const rows = await query(`
    SELECT
      (SELECT COALESCE(SUM(balance),0)
       FROM public.wallet_balances) AS wallet_total,

      (SELECT COALESCE(SUM(commission_amount),0)
       FROM public.referral_commissions) AS commissions,

      (SELECT COALESCE(SUM(stake),0)
       FROM public.bets) AS bets_stake,

      (SELECT COALESCE(SUM(payout),0)
       FROM public.bets
       WHERE status='won') AS bets_payout,

      (SELECT COUNT(*)
       FROM public.bets) AS bet_count,

      (SELECT COUNT(*)
       FROM public.transactions
       WHERE transaction_type='bet'
         AND status IN ('confirmed','completed')) AS bet_tx,

      (SELECT COUNT(*)
       FROM public.transactions
       WHERE transaction_type='payout'
         AND status IN ('confirmed','completed')) AS payout_tx,

      (SELECT COUNT(*)
       FROM public.bets
       WHERE status='won') AS paid_bets
  `);

  const t = rows[0] || {};

  return {
    clean: false,
    totals: {
      wallet_total: Number(t.wallet_total || 0),
      ledger_net: 0,
      commissions: Number(t.commissions || 0),
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
    SELECT
      u.id,
      u.telegram_id,
      u.username,
      w.balance,
      u.referral_code,
      u.referred_by,
      u.created_at
    FROM public.users u
    LEFT JOIN public.wallet_balances w
      ON w.user_id=u.id
    WHERE u.id=$1
    LIMIT 1
  `, [userId]);

  if (!profiles.length) return null;

  const stats = await query(`
    SELECT
      COUNT(*) AS bets,
      COALESCE(SUM(stake),0) AS stake,
      COALESCE(SUM(payout),0) AS payout,
      COUNT(*) FILTER (WHERE status='won') AS wins,
      COUNT(*) FILTER (WHERE status='lost') AS losses
    FROM public.bets
    WHERE user_id=$1
  `, [userId]);

  const recentBets = await query(`
    SELECT
      b.id,
      r.round_code,
      b.bet_type,
      b.selection,
      b.stake,
      b.fee,
      b.status,
      CASE
        WHEN r.ends_at<=NOW() THEN r.result_number
        ELSE NULL
      END AS result_number,
      b.payout,
      b.created_at,
      b.settled_at
    FROM public.bets b
    LEFT JOIN public.game_rounds r
      ON r.id=b.round_id
    WHERE b.user_id=$1
    ORDER BY b.id DESC
    LIMIT 20
  `, [userId]);

  const recentTransactions = await query(`
    SELECT
      id,
      transaction_type,
      amount,
      status,
      network,
      tx_hash,
      created_at
    FROM public.transactions
    WHERE user_id=$1
    ORDER BY id DESC
    LIMIT 20
  `, [userId]);

  const commissions = await query(`
    SELECT
      referral_level,
      COUNT(*) AS count,
      COALESCE(SUM(commission_amount),0) AS total
    FROM public.referral_commissions
    WHERE referrer_user_id=$1
    GROUP BY referral_level
    ORDER BY referral_level
  `, [userId]);

  const referralTree = await query(`
    WITH RECURSIVE referral_tree AS (
      SELECT
        id,
        username,
        referred_by,
        created_at,
        1 AS level,
        ARRAY[id] AS path
      FROM public.users
      WHERE referred_by=$1

      UNION ALL

      SELECT
        u.id,
        u.username,
        u.referred_by,
        u.created_at,
        rt.level+1,
        rt.path || u.id
      FROM public.users u
      JOIN referral_tree rt
        ON u.referred_by=rt.id
      WHERE rt.level<3
        AND NOT u.id=ANY(rt.path)
    )
    SELECT
      id,
      username,
      referred_by,
      created_at,
      level
    FROM referral_tree
    ORDER BY level, id
    LIMIT 200
  `, [userId]);

  const generated = await query(`
    SELECT COALESCE(SUM(commission_amount),0) AS total
    FROM public.referral_commissions
    WHERE source_user_id=$1
  `, [userId]);

  return {
    profile: profiles[0],
    stats: stats[0] || {},
    recent_bets: recentBets,
    recent_transactions: recentTransactions,
    referral_tree: referralTree,
    commissions_earned: commissions,
    commissions_generated: Number(
      generated[0]?.total || 0
    )
  };
}
/*
 * SEARCH
 */

async function searchAction(body) {
  const q = String(body.q || "").trim().slice(0, 100);

  if (q.length < 1) {
    return {
      users: [],
      rounds: [],
      bets: []
    };
  }

  const numeric = /^\d+$/.test(q);

  const [users, rounds, bets] = await Promise.all([
    query(
      `SELECT
         u.id,
         u.telegram_id,
         u.username,
         w.balance,
         u.created_at
       FROM public.users u
       LEFT JOIN public.wallet_balances w
         ON w.user_id=u.id
       WHERE ${
         numeric
           ? "(CAST(u.id AS TEXT)=$1 OR CAST(u.telegram_id AS TEXT)=$1)"
           : "u.username ILIKE $1"
       }
       ORDER BY u.id DESC
       LIMIT 20`,
      [numeric ? q : `%${q}%`]
    ),

    query(
      `SELECT
         id,
         round_code,
         status,
         starts_at,
         ends_at,
         CASE
           WHEN ends_at<=NOW() THEN result_number
           ELSE NULL
         END AS result_number
       FROM public.game_rounds
       WHERE ${
         numeric
           ? "(CAST(id AS TEXT)=$1 OR round_code ILIKE $2)"
           : "round_code ILIKE $1"
       }
       ORDER BY id DESC
       LIMIT 20`,
      numeric ? [q, `%${q}%`] : [`%${q}%`]
    ),

    query(
      `SELECT
         b.id,
         b.user_id,
         b.round_id,
         r.round_code,
         b.bet_type,
         b.selection,
         b.stake,
         b.status,
         b.payout,
         b.created_at
       FROM public.bets b
       LEFT JOIN public.game_rounds r
         ON r.id=b.round_id
       WHERE ${
         numeric
           ? "(CAST(b.id AS TEXT)=$1 OR CAST(b.user_id AS TEXT)=$1)"
           : "r.round_code ILIKE $1"
       }
       ORDER BY b.id DESC
       LIMIT 20`,
      [numeric ? q : `%${q}%`]
    )
  ]);

  return { users, rounds, bets };
}

/*
 * LOGIN ATTEMPTS
 */

async function loginAttempts(body) {
  const { page, size, offset } = pagination(body);

  const totalRows = await query(`
    SELECT COUNT(*) AS total
    FROM public.admin_login_attempts
  `);

  const entries = await query(
    `SELECT
       id,
       ip,
       success,
       attempted_at
     FROM public.admin_login_attempts
     ORDER BY attempted_at DESC
     LIMIT $1 OFFSET $2`,
    [size, offset]
  );

  const total = Number(totalRows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / size));

  return {
    entries,
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
 * CSV EXPORT
 */

function csvCell(value) {
  if (value === null || value === undefined) {
    return '""';
  }

  let textValue = String(value);

  // Prevent spreadsheet formula injection.
  if (/^[\s]*[=+\-@]/.test(textValue)) {
    textValue = "'" + textValue;
  }

  return '"' + textValue.replace(/"/g, '""') + '"';
}

async function exportCsv(body) {
  const action = String(body.dataset || "");

  if (!Object.prototype.hasOwnProperty.call(LISTS, action)) {
    throw new Error("Unsupported export dataset.");
  }

  const cfg = LISTS[action];
  const conditions = [];
  const params = [];

  function add(condition, value) {
    params.push(value);
    conditions.push(
      condition.replace("?", `$${params.length}`)
    );
  }

  if (action === "users") {
    const segment = String(body.segment || "all");

    if (!USER_SEGMENTS.has(segment)) {
      throw new Error("Invalid user segment.");
    }

    const segmentSql = userSegmentSql(segment);

    if (segmentSql) {
      conditions.push(`(${segmentSql})`);
    }

    if (body.q) {
      const q = String(body.q).trim().slice(0, 100);

      if (/^\d+$/.test(q)) {
        params.push(q, q);
        conditions.push(
          `(CAST(u.telegram_id AS TEXT)=$${params.length - 1}
            OR CAST(u.id AS TEXT)=$${params.length})`
        );
      } else {
        add("u.username ILIKE ?", `%${q}%`);
      }
    }
  }

  if (action === "transactions") {
    if (body.type) {
      const type = String(body.type);

      if (!["deposit", "withdrawal"].includes(type)) {
        throw new Error("Invalid transaction type.");
      }

      add("transaction_type=?", type);
    }

    if (body.status) {
      const status = String(body.status);

      if (!STATUSES.has(status)) {
        throw new Error("Invalid status.");
      }

      add("status=?", status);
    }

    if (body.user_id) {
      if (!/^\d{1,15}$/.test(String(body.user_id))) {
        throw new Error("Invalid user ID.");
      }

      add("user_id=?", String(body.user_id));
    }
  }

  if (action === "bets") {
    if (body.user_id) {
      if (!/^\d{1,15}$/.test(String(body.user_id))) {
        throw new Error("Invalid user ID.");
      }

      add("b.user_id=?", String(body.user_id));
    }

    if (body.status) {
      const status = String(body.status);

      if (!STATUSES.has(status)) {
        throw new Error("Invalid status.");
      }

      add("b.status=?", status);
    }
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const rows = await query(
    `SELECT ${cfg.select}
     FROM ${cfg.from}
     ${where}
     ${cfg.group || ""}
     ORDER BY ${cfg.order}
     LIMIT $${params.length + 1}`,
    [...params, EXPORT_MAX]
  );

  if (!rows.length) {
    return {
      csv: "",
      row_count: 0,
      truncated: false
    };
  }

  const headers = Object.keys(rows[0]);

  const csv = [
    headers.map(csvCell).join(","),
    ...rows.map(row =>
      headers.map(key => csvCell(row[key])).join(",")
    )
  ].join("\r\n");

  return {
    csv,
    row_count: rows.length,
    truncated: rows.length === EXPORT_MAX
  };
}

/*
 * MAIN API HANDLER
 */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, {
      ok: false,
      error: "Method not allowed."
    });
  }

  if (!validRequest(req)) {
    return json(res, 403, {
      ok: false,
      error: "Request rejected."
    });
  }

  let body = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return json(res, 400, {
        ok: false,
        error: "Invalid JSON."
      });
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(res, 400, {
      ok: false,
      error: "Invalid request body."
    });
  }

  const action = String(body.action || "").slice(0, 50);

  try {
    getConfig();

    /*
     * LOGIN
     */
    if (action === "login") {
      if (!(await loginAllowed(req))) {
        await audit(
          "unknown",
          "login",
          req,
          "rate_limited"
        );

        return json(res, 429, {
          ok: false,
          error: "Too many login attempts. Try again in 15 minutes."
        });
      }

      const config = getConfig();

      const username = String(body.username || "");
      const password = String(body.password || "");

      const success =
        safeEqual(username, config.username) &&
        safeEqual(password, config.password);

      await recordLogin(req, success);

      await audit(
        success ? config.username : "unknown",
        "login",
        req,
        success ? "success" : "failed"
      );

      if (!success) {
        return json(res, 401, {
          ok: false,
          error: "Invalid username or password."
        });
      }

      setCookie(res, createSession(config.username), SESSION_SECONDS);

      return json(res, 200, {
        ok: true,
        username: config.username
      });
    }

    /*
     * LOGOUT
     */
    if (action === "logout") {
      const token = readCookie(req, COOKIE);
      const session = verifySession(token);

      if (session) {
        await audit(
          session.username,
          "logout",
          req,
          "success"
        );
      }

      setCookie(res, "", 0);

      return json(res, 200, { ok: true });
    }

    /*
     * AUTHENTICATION
     */
    const token = readCookie(req, COOKIE);
    const session = verifySession(token);

    if (!session) {
      return json(res, 401, {
        ok: false,
        error: "Session expired. Please log in again."
      });
    }

    /*
     * CURRENT SESSION
     */
    if (action === "me") {
      return json(res, 200, {
        ok: true,
        username: session.username,
        expires_in: Math.max(
          0,
          session.exp - Math.floor(Date.now() / 1000)
        )
      });
    }

    let result;

    switch (action) {
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
          return json(res, 400, {
            ok: false,
            error: "Invalid user ID."
          });
        }

        result = await userDetail(userId);

        if (!result) {
          return json(res, 404, {
            ok: false,
            error: "User not found."
          });
        }

        break;
      }

      case "search":
        result = await searchAction(body);
        break;

      case "export":
        result = await exportCsv(body);
        break;

      case "login_attempts":
        result = await loginAttempts(body);
        break;

      default:
        return json(res, 400, {
          ok: false,
          error: "Unknown action."
        });
    }

    await audit(
      session.username,
      action,
      req,
      "success"
    );

    return json(res, 200, {
      ok: true,
      ...result
    });
  } catch (error) {
    console.error(
      "Admin API error:",
      action,
      error.code || error.name
    );

    return json(res, 500, {
      ok: false,
      error: "Admin request failed. Check server logs."
    });
  }
};