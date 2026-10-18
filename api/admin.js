const { Pool } = require("pg");
const crypto = require("crypto");

const COOKIE_NAME = "admin_session";
const SESSION_SECONDS = 2 * 60 * 60;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 20;
const EXPORT_MAX = 5000;
const LARGE_STAKE = 500;

const TX_TYPES = [
  "deposit",
  "withdrawal",
  "bet",
  "payout",
  "refund"
];

const TX_STATUSES = [
  "pending",
  "confirmed",
  "rejected",
  "completed",
  "failed"
];

const BET_STATUSES = [
  "pending",
  "won",
  "lost",
  "cancelled"
];

const ACTIONS = new Set([
  "login",
  "me",
  "logout",
  "dashboard",
  "analytics",
  "reconcile",
  "users",
  "wallets",
  "transactions",
  "rounds",
  "bets",
  "audit",
  "user_detail",
  "search",
  "export"
]);

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error("Database connection is not configured.");
    }

    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    });

    pool.on("error", (err) => {
      console.error("Admin database pool error:", err.code || "DB_ERROR");
    });
  }

  return pool;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(JSON.stringify(body));
}

function getConfig() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;

  if (
    !username ||
    !password ||
    !secret ||
    password.length < 12 ||
    secret.length < 32
  ) {
    return null;
  }

  return { username, password, secret };
}

function safeEqual(a, b) {
  const first = crypto
    .createHash("sha256")
    .update(String(a))
    .digest();

  const second = crypto
    .createHash("sha256")
    .update(String(b))
    .digest();

  return crypto.timingSafeEqual(first, second);
}

function signToken(payload, secret) {
  const body = Buffer
    .from(JSON.stringify(payload))
    .toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64url");

  return `${body}.${signature}`;
}

function verifyToken(token, secret) {
  if (
    typeof token !== "string" ||
    token.length > 1000
  ) {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(parts[0])
    .digest("base64url");

  if (!safeEqual(parts[1], expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8")
    );

    const now = Math.floor(Date.now() / 1000);

    if (
      typeof payload.u !== "string" ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= now ||
      typeof payload.iat !== "number" ||
      payload.iat > now + 60
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const result = {};

  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");

    if (index <= 0) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (key) result[key] = value;
  }

  return result;
}

function setSessionCookie(res, value, maxAge) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; ` +
    `Path=/api/admin; Max-Age=${maxAge}`
  );
}

function getSession(req, config) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const payload = verifyToken(token, config.secret);

  if (!payload || payload.u !== config.username) {
    return null;
  }

  return payload;
}

function clientIp(req) {
  // Vercel supplies x-real-ip for the originating client.
  // Avoid trusting arbitrary x-forwarded-for entries.
  const ip = req.headers["x-real-ip"];

  return typeof ip === "string"
    ? ip.trim().slice(0, 64)
    : "unknown";
}

function parseBody(req) {
  const body = req.body;

  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body)
  ) {
    return body;
  }

  if (typeof body === "string" && body.length <= 16384) {
    try {
      const parsed = JSON.parse(body);

      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed;
      }
    } catch {}
  }

  return {};
}

function pageParams(body, maxSize = 50) {
  const rawPage = Number.parseInt(body.page, 10);
  const rawSize = Number.parseInt(body.page_size, 10);

  const page = Math.min(
    100000,
    Math.max(1, Number.isFinite(rawPage) ? rawPage : 1)
  );

  const size = Math.min(
    maxSize,
    Math.max(1, Number.isFinite(rawSize) ? rawSize : 20)
  );

  return {
    page,
    size,
    offset: (page - 1) * size
  };
}

function pageInfo(page, size, total) {
  return {
    page,
    page_size: size,
    total,
    total_pages: Math.max(1, Math.ceil(total / size)),
    has_next: page * size < total,
    has_previous: page > 1
  };
}

function likeEscape(value) {
  return value.replace(/[\\%_]/g, (match) => "\\" + match);
}

function cleanQuery(body) {
  const q = String(body.q || "")
    .trim()
    .replace(/^@/, "")
    .slice(0, 64);

  return q || null;
}

function userSearch(q, params) {
  if (!q) return "TRUE";

  params.push(q);
  params.push("%" + likeEscape(q) + "%");

  const exact = params.length - 1;
  const partial = params.length;

  return (
    `(u.telegram_id::text = $${exact} ` +
    `OR u.id::text = $${exact} ` +
    `OR u.username ILIKE $${partial} ESCAPE '\\')`
  );
}

function csvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }

  let result = value instanceof Date
    ? value.toISOString()
    : String(value);

  if (/^[=+\-@\t\r]/.test(result)) {
    result = "'" + result;
  }

  if (/[",\r\n]/.test(result)) {
    result = '"' + result.replace(/"/g, '""') + '"';
  }

  return result;
}

async function audit(
  client,
  admin,
  action,
  targetType,
  targetId,
  outcome,
  ip
) {
  await client.query(
    `INSERT INTO public.admin_audit_log
      (admin_username, action, target_type, target_id, outcome, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      admin,
      action,
      targetType || null,
      targetId || null,
      outcome,
      ip
    ]
  );
}

// --------------------------------------------------
// LOGIN
// --------------------------------------------------

async function login(client, req, res, config, body) {
  const ip = clientIp(req);

  await client.query(
    `DELETE FROM public.admin_login_attempts
     WHERE attempted_at < NOW() - INTERVAL '1 day'`
  );

  const attempts = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE ip = $1 AND success = false
       )::int AS ip_fails,
       COUNT(*) FILTER (
         WHERE success = false
       )::int AS global_fails
     FROM public.admin_login_attempts
     WHERE attempted_at > NOW() - INTERVAL '15 minutes'`,
    [ip]
  );

  const failures = attempts.rows[0];

  if (
    failures.ip_fails >= MAX_FAILS_PER_IP ||
    failures.global_fails >= MAX_FAILS_GLOBAL
  ) {
    await audit(
      client,
      "unknown",
      "login",
      null,
      null,
      "denied",
      ip
    );

    return send(res, 429, {
      success: false,
      message: "Too many attempts. Try again later."
    });
  }

  const username = String(body.username || "").slice(0, 200);
  const password = String(body.password || "").slice(0, 200);

  const validUsername = safeEqual(username, config.username);
  const validPassword = safeEqual(password, config.password);

  const valid = validUsername && validPassword;

  await client.query(
    `INSERT INTO public.admin_login_attempts (ip, success)
     VALUES ($1, $2)`,
    [ip, valid]
  );

  if (!valid) {
    await audit(
      client,
      "unknown",
      "login",
      null,
      null,
      "failure",
      ip
    );

    return send(res, 401, {
      success: false,
      message: "Invalid username or password."
    });
  }

  const now = Math.floor(Date.now() / 1000);

  const token = signToken(
    {
      u: config.username,
      iat: now,
      exp: now + SESSION_SECONDS,
      n: crypto.randomBytes(16).toString("hex")
    },
    config.secret
  );

  setSessionCookie(res, token, SESSION_SECONDS);

  await audit(
    client,
    config.username,
    "login",
    null,
    null,
    "success",
    ip
  );

  return send(res, 200, {
    success: true,
    username: config.username
  });
}

// --------------------------------------------------
// DASHBOARD
// --------------------------------------------------

async function dashboard(client) {
  const totals = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM public.users)::int AS users,
      (SELECT COUNT(*) FROM public.bets)::int AS bets,

      (SELECT COALESCE(SUM(stake), 0)
       FROM public.bets)::text AS total_stake,

      (SELECT COALESCE(SUM(fee), 0)
       FROM public.bets)::text AS total_fees,

      (SELECT COALESCE(SUM(payout), 0)
       FROM public.bets)::text AS total_payouts,

      (SELECT COALESCE(SUM(commission_amount), 0)
       FROM public.referral_commissions)::text AS total_commissions,

      (SELECT COALESCE(SUM(balance), 0)
       FROM public.wallet_balances)::text AS total_wallet_balance,

      (SELECT COALESCE(SUM(amount), 0)
       FROM public.transactions
       WHERE transaction_type = 'deposit'
         AND status IN ('completed', 'confirmed')
      )::text AS total_deposits,

      (SELECT COUNT(*)
       FROM public.transactions
       WHERE transaction_type = 'deposit'
      )::int AS deposit_count,

      (SELECT COALESCE(SUM(amount), 0)
       FROM public.transactions
       WHERE transaction_type = 'withdrawal'
         AND status IN ('completed', 'confirmed')
      )::text AS total_withdrawals,

      (SELECT COUNT(*)
       FROM public.transactions
       WHERE transaction_type = 'withdrawal'
      )::int AS withdrawal_count
  `);

  const statuses = await client.query(`
    SELECT status, COUNT(*)::int AS count
    FROM public.game_rounds
    GROUP BY status
    ORDER BY status
  `);

  const health = await client.query(`
    SELECT
      NOW() AS db_time,

      (SELECT MAX(starts_at)
       FROM public.game_rounds) AS latest_round_start,

      (SELECT MAX(settled_at)
       FROM public.game_rounds) AS last_settled_at,

      (SELECT COUNT(*)
       FROM public.game_rounds
       WHERE status NOT IN ('settled', 'cancelled')
         AND betting_closes_at < NOW() - INTERVAL '2 minutes'
      )::int AS overdue_rounds,

      (SELECT COUNT(*)
       FROM public.bets b
       JOIN public.game_rounds r ON r.id = b.round_id
       WHERE b.status = 'pending'
         AND r.ends_at < NOW() - INTERVAL '10 minutes'
      )::int AS old_pending_bets
  `);

  const h = health.rows[0];

  const latest = h.latest_round_start
    ? new Date(h.latest_round_start).getTime()
    : 0;

  const recent = await roundsList(client, 10, 0);

  return {
    success: true,
    totals: totals.rows[0],
    round_statuses: statuses.rows,
    recent_rounds: recent,
    health: {
      database_ok: true,
      db_time: h.db_time,
      latest_round_start: h.latest_round_start,
      last_settled_at: h.last_settled_at,
      overdue_rounds: h.overdue_rounds,
      old_pending_bets: h.old_pending_bets,
      cron_ok:
        latest > Date.now() &&
        h.overdue_rounds === 0 &&
        h.old_pending_bets === 0
    }
  };
}

async function roundsList(client, limit, offset) {
  const result = await client.query(
    `SELECT
       r.id,
       r.round_code,
       r.status,
       r.starts_at,
       r.betting_closes_at,
       r.ends_at,

       CASE
         WHEN r.ends_at <= NOW() THEN r.result_number
       END AS result_number,

       r.settled_at,

       COALESCE(a.bet_count, 0)::int AS bet_count,
       COALESCE(a.total_stake, 0)::text AS total_stake,

       CASE
         WHEN r.ends_at <= NOW()
         THEN COALESCE(a.total_payout, 0)
       END::text AS total_payout,

       COALESCE(a.pending_bets, 0)::int AS pending_bets,

       (
         r.status = 'settled'
         AND COALESCE(a.pending_bets, 0) = 0
       ) AS payout_complete

     FROM public.game_rounds r

     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) AS bet_count,
         SUM(b.stake) AS total_stake,
         SUM(b.payout) AS total_payout,
         COUNT(*) FILTER (
           WHERE b.status = 'pending'
         ) AS pending_bets
       FROM public.bets b
       WHERE b.round_id = r.id
     ) a ON TRUE

     ORDER BY r.starts_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return result.rows;
}

async function rounds(client, body) {
  const { page, size, offset } = pageParams(body);

  const count = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM public.game_rounds`
  );

  return {
    success: true,
    rounds: await roundsList(client, size, offset),
    pagination: pageInfo(page, size, count.rows[0].total)
  };
}

// --------------------------------------------------
// USERS
// --------------------------------------------------

async function users(client, body, maxSize = 50) {
  const { page, size, offset } = pageParams(body, maxSize);

  const params = [];
  const where = userSearch(cleanQuery(body), params);

  const count = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM public.users u
     WHERE ${where}`,
    params
  );

  const rows = await client.query(
    `SELECT
       u.id,
       u.telegram_id::text AS telegram_id,
       u.username,
       u.created_at,
       u.referred_by,
       u.referral_code,

       COALESCE(w.balance, 0)::text AS balance,

       (SELECT COUNT(*)
        FROM public.users c
        WHERE c.referred_by = u.id)::int AS referral_count

     FROM public.users u

     LEFT JOIN public.wallet_balances w
       ON w.user_id = u.id

     WHERE ${where}

     ORDER BY u.id DESC
     LIMIT $${params.length + 1}
     OFFSET $${params.length + 2}`,
    [...params, size, offset]
  );

  return {
    success: true,
    users: rows.rows,
    pagination: pageInfo(page, size, count.rows[0].total)
  };
}

// --------------------------------------------------
// WALLETS
// --------------------------------------------------

async function wallets(client, body) {
  const { page, size, offset } = pageParams(body);

  const params = [];
  const where = userSearch(cleanQuery(body), params);

  const count = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM public.wallet_balances w
     JOIN public.users u ON u.id = w.user_id
     WHERE ${where}`,
    params
  );

  const rows = await client.query(
    `SELECT
       w.user_id,
       u.telegram_id::text AS telegram_id,
       u.username,
       w.balance::text AS balance,
       w.updated_at

     FROM public.wallet_balances w

     JOIN public.users u ON u.id = w.user_id

     WHERE ${where}

     ORDER BY w.updated_at DESC
     LIMIT $${params.length + 1}
     OFFSET $${params.length + 2}`,
    [...params, size, offset]
  );

  return {
    success: true,
    wallets: rows.rows,
    pagination: pageInfo(page, size, count.rows[0].total)
  };
}

// --------------------------------------------------
// TRANSACTIONS
// --------------------------------------------------

async function transactions(client, body, maxSize = 50) {
  const { page, size, offset } = pageParams(body, maxSize);

  const conditions = [];
  const params = [];

  if (/^\d{1,15}$/.test(String(body.user_id || ""))) {
    params.push(String(body.user_id));
    conditions.push(`t.user_id = $${params.length}::bigint`);
  }

  if (TX_TYPES.includes(body.type)) {
    params.push(body.type);
    conditions.push(`t.transaction_type = $${params.length}`);
  }

  if (TX_STATUSES.includes(body.status)) {
    params.push(body.status);
    conditions.push(`t.status = $${params.length}`);
  }

  const where = conditions.length
    ? conditions.join(" AND ")
    : "TRUE";

  const count = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM public.transactions t
     WHERE ${where}`,
    params
  );

  const rows = await client.query(
    `SELECT
       t.id,
       t.user_id,
       t.transaction_type,
       t.amount::text AS amount,
       t.status,
       t.network,
       t.tx_hash,
       t.created_at,
       t.updated_at

     FROM public.transactions t

     WHERE ${where}

     ORDER BY t.id DESC
     LIMIT $${params.length + 1}
     OFFSET $${params.length + 2}`,
    [...params, size, offset]
  );

  return {
    success: true,
    transactions: rows.rows,
    pagination: pageInfo(page, size, count.rows[0].total)
  };
}

// --------------------------------------------------
// BETS
// --------------------------------------------------

async function bets(client, body, maxSize = 50) {
  const { page, size, offset } = pageParams(body, maxSize);

  const conditions = [];
  const params = [];

  if (/^\d{14}$/.test(String(body.round_code || ""))) {
    params.push(String(body.round_code));
    conditions.push(`r.round_code = $${params.length}`);
  }

  if (/^\d{1,15}$/.test(String(body.user_id || ""))) {
    params.push(String(body.user_id));
    conditions.push(`b.user_id = $${params.length}::bigint`);
  }

  if (BET_STATUSES.includes(body.status)) {
    params.push(body.status);

    conditions.push(
      `(CASE
         WHEN r.ends_at <= NOW() THEN b.status
         ELSE 'pending'
       END) = $${params.length}`
    );
  }

  const where = conditions.length
    ? conditions.join(" AND ")
    : "TRUE";

  const count = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM public.bets b
     JOIN public.game_rounds r ON r.id = b.round_id
     WHERE ${where}`,
    params
  );

  const rows = await client.query(
    `SELECT
       b.id,
       b.user_id,
       r.round_code,
       b.bet_type,
       b.selection,
       b.stake::text AS stake,
       b.fee::text AS fee,

       CASE
         WHEN r.ends_at <= NOW() THEN b.status
         ELSE 'pending'
       END AS status,

       CASE
         WHEN r.ends_at <= NOW() THEN r.result_number
       END AS result_number,

       CASE
         WHEN r.ends_at <= NOW() THEN b.payout
         ELSE 0
       END::text AS payout,

       b.created_at,

       CASE
         WHEN r.ends_at <= NOW() THEN b.settled_at
       END AS settled_at

     FROM public.bets b

     JOIN public.game_rounds r ON r.id = b.round_id

     WHERE ${where}

     ORDER BY b.id DESC
     LIMIT $${params.length + 1}
     OFFSET $${params.length + 2}`,
    [...params, size, offset]
  );

  return {
    success: true,
    bets: rows.rows,
    pagination: pageInfo(page, size, count.rows[0].total)
  };
}

// --------------------------------------------------
// AUDIT LOG
// --------------------------------------------------

async function auditLog(client, body) {
  const { page, size, offset } = pageParams(body);

  const count = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM public.admin_audit_log`
  );

  const rows = await client.query(
    `SELECT
       id,
       admin_username,
       action,
       target_type,
       target_id,
       outcome,
       ip,
       created_at

     FROM public.admin_audit_log

     ORDER BY id DESC
     LIMIT $1 OFFSET $2`,
    [size, offset]
  );

  return {
    success: true,
    entries: rows.rows,
    pagination: pageInfo(page, size, count.rows[0].total)
  };
}

// --------------------------------------------------
// ANALYTICS
// --------------------------------------------------

async function analytics(client) {
  const daily = await client.query(`
    WITH days AS (
      SELECT
        ((NOW() AT TIME ZONE 'UTC')::date - g) AS day
      FROM generate_series(0, 13) AS g
    ),

    bet_day AS (
      SELECT
        (r.starts_at AT TIME ZONE 'UTC')::date AS day,
        COUNT(*) AS bets,
        COALESCE(SUM(b.stake), 0) AS stake,
        COALESCE(SUM(b.payout), 0) AS payout,
        COUNT(DISTINCT b.user_id) AS active_users

      FROM public.bets b

      JOIN public.game_rounds r ON r.id = b.round_id

      WHERE r.ends_at <= NOW()
        AND (r.starts_at AT TIME ZONE 'UTC')::date
            >= (NOW() AT TIME ZONE 'UTC')::date - 13

      GROUP BY 1
    ),

    comm_day AS (
      SELECT
        (created_at AT TIME ZONE 'UTC')::date AS day,
        COALESCE(SUM(commission_amount), 0) AS commissions

      FROM public.referral_commissions

      WHERE (created_at AT TIME ZONE 'UTC')::date
            >= (NOW() AT TIME ZONE 'UTC')::date - 13

      GROUP BY 1
    ),

    user_day AS (
      SELECT
        (created_at AT TIME ZONE 'UTC')::date AS day,
        COUNT(*) AS new_users

      FROM public.users

      WHERE (created_at AT TIME ZONE 'UTC')::date
            >= (NOW() AT TIME ZONE 'UTC')::date - 13

      GROUP BY 1
    )

    SELECT
      d.day::text AS day,
      COALESCE(b.bets, 0)::int AS bets,
      COALESCE(b.stake, 0)::text AS stake,
      COALESCE(b.payout, 0)::text AS payout,

      (
        COALESCE(b.stake, 0)
        - COALESCE(b.payout, 0)
        - COALESCE(c.commissions, 0)
      )::text AS net,

      COALESCE(b.active_users, 0)::int AS active_users,
      COALESCE(u.new_users, 0)::int AS new_users

    FROM days d

    LEFT JOIN bet_day b ON b.day = d.day
    LEFT JOIN comm_day c ON c.day = d.day
    LEFT JOIN user_day u ON u.day = d.day

    ORDER BY d.day
  `);

  const results = await client.query(`
    SELECT
      result_number,
      COUNT(*)::int AS count

    FROM public.game_rounds

    WHERE status = 'settled'
      AND result_number IS NOT NULL
      AND ends_at <= NOW()

    GROUP BY result_number
    ORDER BY result_number
  `);

  const counts = Array(10).fill(0);

  for (const row of results.rows) {
    const n = Number(row.result_number);

    if (Number.isInteger(n) && n >= 0 && n <= 9) {
      counts[n] = Number(row.count);
    }
  }

  const totalRounds = counts.reduce((sum, n) => sum + n, 0);

  let chi = null;
  let verdict = "Not enough data (need at least 50 settled rounds).";

  if (totalRounds >= 50) {
    const expected = totalRounds / 10;

    chi = counts.reduce(
      (sum, count) =>
        sum + ((count - expected) ** 2) / expected,
      0
    );

    if (chi > 21.67) {
      verdict = "Strong deviation from a uniform draw. Investigate.";
    } else if (chi > 16.92) {
      verdict = "Possible deviation (p < 0.05). Keep watching.";
    } else {
      verdict = "Consistent with a fair, uniform draw.";
    }
  }

  const topUsers = await client.query(`
    SELECT
      u.id,
      u.username,
      COUNT(*)::int AS bets,
      SUM(b.stake)::text AS stake,
      SUM(b.payout)::text AS payout,
      (SUM(b.payout) - SUM(b.stake))::text AS user_net

    FROM public.bets b

    JOIN public.game_rounds r ON r.id = b.round_id
    JOIN public.users u ON u.id = b.user_id

    WHERE r.ends_at <= NOW()

    GROUP BY u.id, u.username
    ORDER BY SUM(b.stake) DESC
    LIMIT 10
  `);

  const largeStakes = await client.query(
    `SELECT
       b.id,
       b.user_id,
       r.round_code,
       b.bet_type,
       b.stake::text AS stake,
       b.created_at

     FROM public.bets b

     JOIN public.game_rounds r ON r.id = b.round_id

     WHERE b.stake >= $1::numeric
       AND b.created_at > NOW() - INTERVAL '7 days'

     ORDER BY b.created_at DESC
     LIMIT 10`,
    [String(LARGE_STAKE)]
  );

  const highReturn = await client.query(`
    SELECT
      b.user_id,
      COUNT(*)::int AS bets,
      SUM(b.stake)::text AS stake,
      SUM(b.payout)::text AS payout,

      ROUND(
        SUM(b.payout) / NULLIF(SUM(b.stake), 0) * 100,
        1
      )::text AS return_percent

    FROM public.bets b

    JOIN public.game_rounds r ON r.id = b.round_id

    WHERE r.ends_at <= NOW()
      AND b.status IN ('won', 'lost')

    GROUP BY b.user_id

    HAVING COUNT(*) >= 20
       AND SUM(b.payout) > SUM(b.stake) * 1.3

    ORDER BY SUM(b.payout) - SUM(b.stake) DESC
    LIMIT 10
  `);

  return {
    success: true,
    daily: daily.rows,

    fairness: {
      total_rounds: totalRounds,
      counts,
      chi_square: chi === null ? null : Number(chi.toFixed(2)),
      verdict
    },

    top_users: topUsers.rows,
    large_stake_threshold: LARGE_STAKE,
    large_stakes: largeStakes.rows,
    high_return_users: highReturn.rows
  };
}

// --------------------------------------------------
// RECONCILIATION
// --------------------------------------------------

async function reconcile(client) {
  const totals = await client.query(`
    WITH t AS (
      SELECT

        (SELECT COALESCE(SUM(balance), 0)
         FROM public.wallet_balances) AS wallet_total,

        (SELECT COALESCE(SUM(
          CASE
            WHEN transaction_type IN ('deposit', 'payout', 'refund')
            THEN amount
            ELSE -amount
          END
        ), 0)
         FROM public.transactions
         WHERE status IN ('completed', 'confirmed')
        ) AS ledger_net,

        (SELECT COALESCE(SUM(commission_amount), 0)
         FROM public.referral_commissions) AS commissions,

        (SELECT COALESCE(SUM(stake), 0)
         FROM public.bets) AS bets_stake,

        (SELECT COALESCE(SUM(amount), 0)
         FROM public.transactions
         WHERE transaction_type = 'bet'
           AND status = 'completed'
        ) AS bet_tx,

        (SELECT COALESCE(SUM(payout), 0)
         FROM public.bets) AS bets_payout,

        (SELECT COALESCE(SUM(amount), 0)
         FROM public.transactions
         WHERE transaction_type = 'payout'
           AND status = 'completed'
        ) AS payout_tx,

        (SELECT COUNT(*) FROM public.bets) AS bet_count,

        (SELECT COUNT(*)
         FROM public.transactions
         WHERE transaction_type = 'bet'
        ) AS bet_tx_count,

        (SELECT COUNT(*)
         FROM public.bets
         WHERE payout > 0) AS paid_bets,

        (SELECT COUNT(*)
         FROM public.transactions
         WHERE transaction_type = 'payout'
        ) AS payout_tx_count
    )

    SELECT
      wallet_total::text,
      ledger_net::text,
      commissions::text,

      (wallet_total - ledger_net - commissions)::text AS unrecorded,

      bets_stake::text,
      bet_tx::text,
      (bets_stake - bet_tx)::text AS stake_diff,

      bets_payout::text,
      payout_tx::text,
      (bets_payout - payout_tx)::text AS payout_diff,

      (bet_count - bet_tx_count)::int AS bet_count_diff,
      (paid_bets - payout_tx_count)::int AS payout_count_diff

    FROM t
  `);

  const mismatches = await client.query(`
    SELECT
      u.id,
      u.username,
      w.balance::text AS balance,

      (
        COALESCE(l.net, 0)
        + COALESCE(c.comm, 0)
      )::text AS expected,

      (
        w.balance
        - COALESCE(l.net, 0)
        - COALESCE(c.comm, 0)
      )::text AS diff

    FROM public.users u

    JOIN public.wallet_balances w ON w.user_id = u.id

    LEFT JOIN (
      SELECT
        user_id,

        SUM(
          CASE
            WHEN transaction_type IN ('deposit', 'payout', 'refund')
            THEN amount
            ELSE -amount
          END
        ) AS net

      FROM public.transactions

      WHERE status IN ('completed', 'confirmed')

      GROUP BY user_id
    ) l ON l.user_id = u.id

    LEFT JOIN (
      SELECT
        referrer_user_id,
        SUM(commission_amount) AS comm

      FROM public.referral_commissions

      GROUP BY referrer_user_id
    ) c ON c.referrer_user_id = u.id

    WHERE w.balance <>
      COALESCE(l.net, 0) + COALESCE(c.comm, 0)

    ORDER BY ABS(
      w.balance - COALESCE(l.net, 0) - COALESCE(c.comm, 0)
    ) DESC

    LIMIT 20
  `);

  const t = totals.rows[0];

  const clean =
    Number(t.unrecorded) === 0 &&
    Number(t.stake_diff) === 0 &&
    Number(t.payout_diff) === 0 &&
    t.bet_count_diff === 0 &&
    t.payout_count_diff === 0;

  return {
    success: true,
    clean,
    totals: t,
    mismatches: mismatches.rows
  };
}

// --------------------------------------------------
// USER DETAILS
// --------------------------------------------------

async function userDetail(client, body) {
  const id = String(body.user_id || "");

  if (!/^\d{1,15}$/.test(id)) {
    return {
      success: false,
      message: "Invalid user ID."
    };
  }

  const profile = await client.query(
    `SELECT
       u.id,
       u.telegram_id::text AS telegram_id,
       u.username,
       u.created_at,
       u.referral_code,
       u.referred_by,
       ru.username AS referrer_username,
       COALESCE(w.balance, 0)::text AS balance,
       w.updated_at AS balance_updated_at

     FROM public.users u

     LEFT JOIN public.wallet_balances w ON w.user_id = u.id
     LEFT JOIN public.users ru ON ru.id = u.referred_by

     WHERE u.id = $1::bigint`,
    [id]
  );

  if (!profile.rows.length) {
    return {
      success: false,
      message: "User not found."
    };
  }

  const stats = await client.query(
    `SELECT
       COUNT(*)::int AS bets,
       COALESCE(SUM(b.stake), 0)::text AS stake,
       COALESCE(SUM(b.payout), 0)::text AS payout,

       COUNT(*) FILTER (
         WHERE b.status = 'won'
       )::int AS wins,

       COUNT(*) FILTER (
         WHERE b.status = 'lost'
       )::int AS losses

     FROM public.bets b

     JOIN public.game_rounds r ON r.id = b.round_id

     WHERE b.user_id = $1::bigint
       AND r.ends_at <= NOW()`,
    [id]
  );

  const recentBets = await client.query(
    `SELECT
       b.id,
       r.round_code,
       b.bet_type,
       b.selection,
       b.stake::text AS stake,
       b.fee::text AS fee,

       CASE
         WHEN r.ends_at <= NOW() THEN b.status
         ELSE 'pending'
       END AS status,

       CASE
         WHEN r.ends_at <= NOW() THEN r.result_number
       END AS result_number,

       CASE
         WHEN r.ends_at <= NOW() THEN b.payout
         ELSE 0
       END::text AS payout,

       b.created_at

     FROM public.bets b

     JOIN public.game_rounds r ON r.id = b.round_id

     WHERE b.user_id = $1::bigint

     ORDER BY b.id DESC
     LIMIT 20`,
    [id]
  );

  const recentTransactions = await client.query(
    `SELECT
       id,
       transaction_type,
       amount::text AS amount,
       status,
       network,
       tx_hash,
       created_at

     FROM public.transactions

     WHERE user_id = $1::bigint

     ORDER BY id DESC
     LIMIT 20`,
    [id]
  );

  const tree = await client.query(
    `WITH RECURSIVE tree AS (
       SELECT
         id,
         username,
         referred_by,
         created_at,
         1 AS level

       FROM public.users

       WHERE referred_by = $1::bigint

       UNION ALL

       SELECT
         u.id,
         u.username,
         u.referred_by,
         u.created_at,
         t.level + 1

       FROM public.users u

       JOIN tree t ON u.referred_by = t.id

       WHERE t.level < 3
     )

     SELECT id, username, referred_by, created_at, level

     FROM tree

     ORDER BY level, id

     LIMIT 200`,
    [id]
  );

  const earned = await client.query(
    `SELECT
       referral_level,
       COUNT(*)::int AS count,
       COALESCE(SUM(commission_amount), 0)::text AS total

     FROM public.referral_commissions

     WHERE referrer_user_id = $1::bigint

     GROUP BY referral_level

     ORDER BY referral_level`,
    [id]
  );

  const generated = await client.query(
    `SELECT
       COALESCE(SUM(commission_amount), 0)::text AS total

     FROM public.referral_commissions

     WHERE source_user_id = $1::bigint`,
    [id]
  );

  return {
    success: true,
    profile: profile.rows[0],
    stats: stats.rows[0],
    recent_bets: recentBets.rows,
    recent_transactions: recentTransactions.rows,
    referral_tree: tree.rows,
    commissions_earned: earned.rows,
    commissions_generated: generated.rows[0].total
  };
}

// --------------------------------------------------
// SEARCH
// --------------------------------------------------

async function search(client, body) {
  const q = cleanQuery(body);

  if (!q) {
    return {
      success: true,
      users: [],
      rounds: [],
      bets: []
    };
  }

  const params = [];
  const where = userSearch(q, params);

  const usersResult = await client.query(
    `SELECT
       u.id,
       u.telegram_id::text AS telegram_id,
       u.username,
       COALESCE(w.balance, 0)::text AS balance

     FROM public.users u

     LEFT JOIN public.wallet_balances w ON w.user_id = u.id

     WHERE ${where}

     ORDER BY u.id DESC
     LIMIT 10`,
    params
  );

  let roundRows = [];

  if (/^\d{6,14}$/.test(q)) {
    const result = await client.query(
      `SELECT round_code, status, starts_at, ends_at

       FROM public.game_rounds

       WHERE round_code LIKE $1

       ORDER BY starts_at DESC
       LIMIT 5`,
      [q + "%"]
    );

    roundRows = result.rows;
  }

  let betRows = [];

  if (/^\d{1,15}$/.test(q)) {
    const result = await client.query(
      `SELECT
         b.id,
         b.user_id,
         r.round_code,
         b.bet_type,
         b.stake::text AS stake,

         CASE
           WHEN r.ends_at <= NOW() THEN b.status
           ELSE 'pending'
         END AS status

       FROM public.bets b

       JOIN public.game_rounds r ON r.id = b.round_id

       WHERE b.id = $1::bigint`,
      [q]
    );

    betRows = result.rows;
  }

  return {
    success: true,
    users: usersResult.rows,
    rounds: roundRows,
    bets: betRows
  };
}

// --------------------------------------------------
// CSV EXPORT
// --------------------------------------------------

const EXPORT_KINDS = {
  users: {
    fn: users,
    key: "users",
    cols: [
      "id",
      "telegram_id",
      "username",
      "balance",
      "referral_count",
      "referred_by",
      "referral_code",
      "created_at"
    ]
  },

  bets: {
    fn: bets,
    key: "bets",
    cols: [
      "id",
      "user_id",
      "round_code",
      "bet_type",
      "selection",
      "stake",
      "fee",
      "status",
      "result_number",
      "payout",
      "created_at",
      "settled_at"
    ]
  },

  transactions: {
    fn: transactions,
    key: "transactions",
    cols: [
      "id",
      "user_id",
      "transaction_type",
      "amount",
      "status",
      "network",
      "tx_hash",
      "created_at",
      "updated_at"
    ]
  }
};

async function exportData(client, body, admin, ip) {
  const kind = String(body.kind || "");

  if (!Object.prototype.hasOwnProperty.call(EXPORT_KINDS, kind)) {
    return {
      success: false,
      message: "Unknown export type."
    };
  }

  const spec = EXPORT_KINDS[kind];

  const data = await spec.fn(
    client,
    {
      ...body,
      page: 1,
      page_size: EXPORT_MAX
    },
    EXPORT_MAX
  );

  const rows = data[spec.key] || [];

  const lines = [
    spec.cols.map(csvCell).join(",")
  ];

  for (const row of rows) {
    lines.push(
      spec.cols.map((column) => csvCell(row[column])).join(",")
    );
  }

  await audit(
    client,
    admin,
    "export",
    kind,
    `${rows.length} rows`,
    "success",
    ip
  );

  return {
    success: true,
    csv: lines.join("\r\n"),
    row_count: rows.length,
    total: data.pagination.total,
    truncated: data.pagination.total > rows.length
  };
}

// --------------------------------------------------
// MAIN HANDLER
// --------------------------------------------------

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return send(res, 405, {
      success: false,
      message: "Method not allowed."
    });
  }

  if (req.headers["x-admin-request"] !== "1") {
    return send(res, 403, {
      success: false,
      message: "Forbidden."
    });
  }

  const origin = req.headers.origin;

  if (origin) {
    try {
      const originUrl = new URL(origin);

      if (
        originUrl.host !== req.headers.host ||
        originUrl.protocol !== "https:"
      ) {
        return send(res, 403, {
          success: false,
          message: "Forbidden."
        });
      }
    } catch {
      return send(res, 403, {
        success: false,
        message: "Forbidden."
      });
    }
  }

  const config = getConfig();

  if (!config) {
    return send(res, 503, {
      success: false,
      message: "Admin is not configured."
    });
  }

  const body = parseBody(req);
  const action = String(body.action || "");

  if (!ACTIONS.has(action)) {
    return send(res, 400, {
      success: false,
      message: "Unknown action."
    });
  }

  let client;

  try {
    client = await getPool().connect();

    if (action === "login") {
      return await login(client, req, res, config, body);
    }

    const session = getSession(req, config);

    if (!session) {
      return send(res, 401, {
        success: false,
        message: "Session expired. Please log in again."
      });
    }

    if (action === "me") {
      return send(res, 200, {
        success: true,
        username: session.u
      });
    }

    if (action === "logout") {
      setSessionCookie(res, "", 0);

      await audit(
        client,
        session.u,
        "logout",
        null,
        null,
        "success",
        clientIp(req)
      );

      return send(res, 200, {
        success: true
      });
    }

    const handlers = {
      dashboard: () => dashboard(client),
      analytics: () => analytics(client),
      reconcile: () => reconcile(client),
      users: () => users(client, body),
      wallets: () => wallets(client, body),
      transactions: () => transactions(client, body),
      rounds: () => rounds(client, body),
      bets: () => bets(client, body),
      audit: () => auditLog(client, body),
      user_detail: () => userDetail(client, body),
      search: () => search(client, body),
      export: () => exportData(
        client,
        body,
        session.u,
        clientIp(req)
      )
    };

    const output = await handlers[action]();

    return send(
      res,
      output && output.success === false ? 400 : 200,
      output
    );
  } catch (error) {
    console.error(
      "Admin API error:",
      error.code || "UNKNOWN",
      error.message
    );

    if (error.code === "42P01") {
      return send(res, 500, {
        success: false,
        message: "A required admin database table is missing."
      });
    }

    return send(res, 500, {
      success: false,
      message: "Request failed."
    });
  } finally {
    if (client) {
      client.release();
    }
  }
};