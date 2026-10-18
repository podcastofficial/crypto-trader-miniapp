const { Pool } = require("pg");
const crypto = require("crypto");

const COOKIE_NAME = "admin_session";
const SESSION_SECONDS = 2 * 60 * 60;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 20;

const TX_TYPES = ["deposit", "withdrawal", "bet", "payout", "refund"];
const TX_STATUSES = [
  "pending", "confirmed", "rejected", "completed", "failed"
];
const BET_STATUSES = ["pending", "won", "lost", "cancelled"];

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is missing");
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

function getConfig() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (
    !username || !password || !secret ||
    password.length < 12 || secret.length < 32
  ) {
    return null;
  }
  return { username, password, secret };
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || token.length > 1000) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(parts[0])
    .digest("base64url");
  if (!safeEqual(parts[1], expected)) return null;

  try {
    const p = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8")
    );
    if (
      typeof p.u !== "string" ||
      !Number.isFinite(p.exp) ||
      p.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function setSessionCookie(res, value, maxAge) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; ` +
      `Path=/api/admin; Max-Age=${maxAge}`
  );
}

function getSession(req, cfg) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const payload = verifyToken(token, cfg.secret);
  if (!payload || payload.u !== cfg.username) return null;
  return payload;
}

function clientIp(req) {
  const raw =
    req.headers["x-real-ip"] ||
    String(req.headers["x-forwarded-for"] || "").split(",")[0] ||
    "unknown";
  return String(raw).trim().slice(0, 64);
}

function parseBody(req) {
  const b = req.body;
  if (b && typeof b === "object") return b;
  if (typeof b === "string") {
    try { return JSON.parse(b); } catch { return {}; }
  }
  return {};
}

function pageParams(body) {
  const page = Math.min(
    100000,
    Math.max(1, parseInt(body.page, 10) || 1)
  );
  const size = Math.min(
    50,
    Math.max(1, parseInt(body.page_size, 10) || 20)
  );
  return { page, size, offset: (page - 1) * size };
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

function likeEscape(s) {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

function cleanQuery(body) {
  const q = String(body.q || "").trim().replace(/^@/, "").slice(0, 64);
  return q || null;
}

// Builds a WHERE clause using placeholders only.
function userSearch(q, params) {
  if (!q) return "TRUE";
  params.push(q);
  params.push("%" + likeEscape(q) + "%");
  const a = params.length - 1;
  const b = params.length;
  return (
    `(u.telegram_id::text = $${a} OR u.id::text = $${a} ` +
    `OR u.username ILIKE $${b} ESCAPE '\\')`
  );
}

async function audit(client, admin, action, targetType, targetId, outcome, ip) {
  await client.query(
    `INSERT INTO public.admin_audit_log
       (admin_username, action, target_type, target_id, outcome, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [admin, action, targetType || null, targetId || null, outcome, ip]
  );
}

// ---------- Actions ----------

async function login(client, req, res, cfg, body) {
  const ip = clientIp(req);

  await client.query(
    `DELETE FROM public.admin_login_attempts
     WHERE attempted_at < NOW() - INTERVAL '1 day'`
  );

  const ipFails = await client.query(
    `SELECT COUNT(*)::int AS n
     FROM public.admin_login_attempts
     WHERE ip = $1 AND success = false
       AND attempted_at > NOW() - INTERVAL '15 minutes'`,
    [ip]
  );
  const allFails = await client.query(
    `SELECT COUNT(*)::int AS n
     FROM public.admin_login_attempts
     WHERE success = false
       AND attempted_at > NOW() - INTERVAL '15 minutes'`
  );

  if (
    ipFails.rows[0].n >= MAX_FAILS_PER_IP ||
    allFails.rows[0].n >= MAX_FAILS_GLOBAL
  ) {
    await audit(client, "unknown", "login", null, null, "denied", ip);
    return send(res, 429, {
      success: false,
      message: "Too many attempts. Try again later."
    });
  }

  const userOk = safeEqual(String(body.username || "").slice(0, 200), cfg.username);
  const passOk = safeEqual(String(body.password || "").slice(0, 200), cfg.password);
  const ok = userOk && passOk;

  await client.query(
    `INSERT INTO public.admin_login_attempts (ip, success) VALUES ($1, $2)`,
    [ip, ok]
  );

  if (!ok) {
    await audit(client, "unknown", "login", null, null, "failure", ip);
    return send(res, 401, {
      success: false,
      message: "Invalid username or password."
    });
  }

  const token = signToken(
    {
      u: cfg.username,
      exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
      n: crypto.randomBytes(8).toString("hex")
    },
    cfg.secret
  );

  setSessionCookie(res, token, SESSION_SECONDS);
  await audit(client, cfg.username, "login", null, null, "success", ip);

  return send(res, 200, { success: true, username: cfg.username });
}

async function dashboard(client) {
  const totals = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM public.users)::int AS users,
      (SELECT COUNT(*) FROM public.bets)::int AS bets,
      (SELECT COALESCE(SUM(stake), 0) FROM public.bets)::text AS total_stake,
      (SELECT COALESCE(SUM(fee), 0) FROM public.bets)::text AS total_fees,
      (SELECT COALESCE(SUM(payout), 0) FROM public.bets)::text AS total_payouts,
      (SELECT COALESCE(SUM(commission_amount), 0)
         FROM public.referral_commissions)::text AS total_commissions,
      (SELECT COALESCE(SUM(balance), 0)
         FROM public.wallet_balances)::text AS total_wallet_balance,
      (SELECT COALESCE(SUM(amount), 0) FROM public.transactions
         WHERE transaction_type = 'deposit'
           AND status IN ('completed', 'confirmed'))::text AS total_deposits,
      (SELECT COUNT(*) FROM public.transactions
         WHERE transaction_type = 'deposit')::int AS deposit_count,
      (SELECT COALESCE(SUM(amount), 0) FROM public.transactions
         WHERE transaction_type = 'withdrawal'
           AND status IN ('completed', 'confirmed'))::text AS total_withdrawals,
      (SELECT COUNT(*) FROM public.transactions
         WHERE transaction_type = 'withdrawal')::int AS withdrawal_count
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
      (SELECT MAX(starts_at) FROM public.game_rounds) AS latest_round_start,
      (SELECT MAX(settled_at) FROM public.game_rounds) AS last_settled_at,
      (SELECT COUNT(*) FROM public.game_rounds
         WHERE status NOT IN ('settled', 'cancelled')
           AND betting_closes_at < NOW() - INTERVAL '2 minutes')::int
        AS overdue_rounds,
      (SELECT COUNT(*) FROM public.bets b
         JOIN public.game_rounds r ON r.id = b.round_id
         WHERE b.status = 'pending'
           AND r.ends_at < NOW() - INTERVAL '10 minutes')::int
        AS old_pending_bets
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
       r.id, r.round_code, r.status, r.starts_at,
       r.betting_closes_at, r.ends_at,
       CASE WHEN r.ends_at <= NOW() THEN r.result_number END
         AS result_number,
       r.settled_at,
       COALESCE(a.bet_count, 0)::int AS bet_count,
       COALESCE(a.total_stake, 0)::text AS total_stake,
       (CASE WHEN r.ends_at <= NOW()
          THEN COALESCE(a.total_payout, 0) END)::text AS total_payout,
       COALESCE(a.pending_bets, 0)::int AS pending_bets,
       (r.status = 'settled' AND COALESCE(a.pending_bets, 0) = 0)
         AS payout_complete
     FROM public.game_rounds r
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) AS bet_count,
         SUM(b.stake) AS total_stake,
         SUM(b.payout) AS total_payout,
         COUNT(*) FILTER (WHERE b.status = 'pending') AS pending_bets
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
    "SELECT COUNT(*)::int AS total FROM public.game_rounds"
  );
  const rows = await roundsList(client, size, offset);
  return {
    success: true,
    rounds: rows,
    pagination: pageInfo(page, size, count.rows[0].total)
  };
}

async function users(client, body) {
  const { page, size, offset } = pageParams(body);
  const params = [];
  const where = userSearch(cleanQuery(body), params);

  const count = await client.query(
    `SELECT COUNT(*)::int AS total FROM public.users u WHERE ${where}`,
    params
  );

  const rows = await client.query(
    `SELECT
       u.id, u.telegram_id::text AS telegram_id, u.username,
       u.created_at, u.referred_by, u.referral_code,
       COALESCE(w.balance, 0)::text AS balance,
       (SELECT COUNT(*) FROM public.users c
          WHERE c.referred_by = u.id)::int AS referral_count
     FROM public.users u
     LEFT JOIN public.wallet_balances w ON w.user_id = u.id
     WHERE ${where}
     ORDER BY u.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, size, offset]
  );

  return {
    success: true,
    users: rows.rows,
    pagination: pageInfo(page, size, count.rows[0].total)
  };
}

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
       w.user_id, u.telegram_id::text AS telegram_id, u.username,
       w.balance::text AS balance, w.updated_at
     FROM public.wallet_balances w
     JOIN public.users u ON u.id = w.user_id
     WHERE ${where}
     ORDER BY w.updated_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, size, offset]
  );

  return {
    success: true,
    wallets: rows.rows,
    pagination: pageInfo(page, size, count.rows[0].total)
  };
}

async function transactions(client, body) {
  const { page, size, offset } = pageParams(body);
  const conds = [];
  const params = [];

  if (/^\d{1,15}$/.test(String(body.user_id || ""))) {
    params.push(String(body.user_id));
    conds.push(`t.user_id = $${params.length}::bigint`);
  }
  if (TX_TYPES.includes(body.type)) {
    params.push(body.type);
    conds.push(`t.transaction_type = $${params.length}`);
  }
  if (TX_STATUSES.includes(body.status)) {
    params.push(body.status);
    conds.push(`t.status = $${params.length}`);
  }
  const where = conds.length ? conds.join(" AND ") : "TRUE";

  const count = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM public.transactions t WHERE ${where}`,
    params
  );

  const rows = await client.query(
    `SELECT
       t.id, t.user_id, t.transaction_type, t.amount::text AS amount,
       t.status, t.network, t.tx_hash, t.created_at, t.updated_at
     FROM public.transactions t
     WHERE ${where}
     ORDER BY t.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, size, offset]
  );

  return {
    success: true,
    transactions: rows.rows,
    pagination: pageInfo(page, size, count.rows[0].total)
  };
}

async function bets(client, body) {
  const { page, size, offset } = pageParams(body);
  const conds = [];
  const params = [];

  if (/^\d{14}$/.test(String(body.round_code || ""))) {
    params.push(String(body.round_code));
    conds.push(`r.round_code = $${params.length}`);
  }
  if (/^\d{1,15}$/.test(String(body.user_id || ""))) {
    params.push(String(body.user_id));
    conds.push(`b.user_id = $${params.length}::bigint`);
  }
  if (BET_STATUSES.includes(body.status)) {
    params.push(body.status);
    conds.push(
      `(CASE WHEN r.ends_at <= NOW() THEN b.status ELSE 'pending' END)` +
        ` = $${params.length}`
    );
  }
  const where = conds.length ? conds.join(" AND ") : "TRUE";

  const count = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM public.bets b
     JOIN public.game_rounds r ON r.id = b.round_id
     WHERE ${where}`,
    params
  );

  const rows = await client.query(
    `SELECT
       b.id, b.user_id, r.round_code, b.bet_type, b.selection,
       b.stake::text AS stake, b.fee::text AS fee,
       CASE WHEN r.ends_at <= NOW() THEN b.status ELSE 'pending' END
         AS status,
       CASE WHEN r.ends_at <= NOW() THEN r.result_number END
         AS result_number,
       (CASE WHEN r.ends_at <= NOW() THEN b.payout ELSE 0 END)::text
         AS payout,
       b.created_at,
       CASE WHEN r.ends_at <= NOW() THEN b.settled_at END AS settled_at
     FROM public.bets b
     JOIN public.game_rounds r ON r.id = b.round_id
     WHERE ${where}
     ORDER BY b.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, size, offset]
  );

  return {
    success: true,
    bets: rows.rows,
    pagination: pageInfo(page, size, count.rows[0].total)
  };
}

async function auditLog(client, body) {
  const { page, size, offset } = pageParams(body);
  const count = await client.query(
    "SELECT COUNT(*)::int AS total FROM public.admin_audit_log"
  );
  const rows = await client.query(
    `SELECT id, admin_username, action, target_type, target_id,
            outcome, ip, created_at
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

// ---------- Handler ----------

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { success: false, message: "Method not allowed" });
  }

  // CSRF defence: custom header + same-origin check + SameSite cookie.
  if (req.headers["x-admin-request"] !== "1") {
    return send(res, 403, { success: false, message: "Forbidden" });
  }

  const origin = req.headers.origin;
  if (origin) {
    let originHost = "";
    try { originHost = new URL(origin).host; } catch {}
    if (originHost !== req.headers.host) {
      return send(res, 403, { success: false, message: "Forbidden" });
    }
  }

  const cfg = getConfig();
  if (!cfg) {
    // TEMPORARY diagnostic: shows only which setting is missing/short.
    // No values are ever shown. Remove after setup works.
    const problems = [];
    const u = process.env.ADMIN_USERNAME;
    const p = process.env.ADMIN_PASSWORD;
    const s = process.env.ADMIN_SESSION_SECRET;
    if (!u) problems.push("ADMIN_USERNAME missing");
    if (!p) problems.push("ADMIN_PASSWORD missing");
    else if (p.length < 12) problems.push("ADMIN_PASSWORD too short (min 12)");
    if (!s) problems.push("ADMIN_SESSION_SECRET missing");
    else if (s.length < 32) problems.push("ADMIN_SESSION_SECRET too short (min 32)");
    return send(res, 503, {
      success: false,
      message: "Admin is not configured: " + problems.join(", ")
    });
  }

  const body = parseBody(req);
  const action = String(body.action || "");
  let client;

  try {
    client = await getPool().connect();

    if (action === "login") {
      return await login(client, req, res, cfg, body);
    }

    const session = getSession(req, cfg);
    if (!session) {
      return send(res, 401, {
        success: false,
        message: "Session expired. Please log in again."
      });
    }

    if (action === "me") {
      return send(res, 200, { success: true, username: session.u });
    }

    if (action === "logout") {
      setSessionCookie(res, "", 0);
      await audit(client, session.u, "logout", null, null, "success", clientIp(req));
      return send(res, 200, { success: true });
    }

    const handlers = {
      dashboard: () => dashboard(client),
      users: () => users(client, body),
      wallets: () => wallets(client, body),
      transactions: () => transactions(client, body),
      rounds: () => rounds(client, body),
      bets: () => bets(client, body),
      audit: () => auditLog(client, body)
    };

    if (!Object.prototype.hasOwnProperty.call(handlers, action)) {
      return send(res, 400, { success: false, message: "Unknown action." });
    }

    return send(res, 200, await handlers[action]());
  } catch (error) {
    console.error("Admin API error:", error.code || "", error.message);

    if (error.code === "42P01") {
      return send(res, 500, {
        success: false,
        message: "Admin tables are missing. Run the migration first."
      });
    }

    return send(res, 500, {
      success: false,
      message: "Request failed."
    });
  } finally {
    if (client) client.release();
  }
};