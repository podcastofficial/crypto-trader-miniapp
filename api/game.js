const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

const BET_TYPES = ["Number", "Red", "Green", "Violet", "Big", "Small"];
const POINTS_PER_USDT = 100;
const MIN_BET_POINTS = 10;
const MIN_DEPOSIT_POINTS = 100;
const MIN_WITHDRAW_POINTS = 500;
const ROUND_LOCK_KEY = 739184205; // same lock key as api/cron.js

function json(res, status, data) {
  return res.status(status).json(data);
}

function pageParams(input = {}) {
  const page = Math.max(1, parseInt(input.page || "1", 10) || 1);
  const pageSize = Math.min(
    10,
    Math.max(1, parseInt(input.page_size || "10", 10) || 10)
  );

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

// Makes sure the current round and a few future rounds exist,
// so the game never depends on the cron timing.
// Safe to run many times: unique round_code + advisory lock.
async function ensureRounds(client) {
  try {
    const check = await client.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM public.game_rounds
          WHERE starts_at <= NOW() AND ends_at > NOW()
        ) AS has_current,
        COALESCE(
          (SELECT MAX(starts_at) FROM public.game_rounds)
            >= NOW() + INTERVAL '6 minutes',
          false
        ) AS has_future
    `);

    if (check.rows[0].has_current && check.rows[0].has_future) return;

    await client.query("BEGIN");

    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS ok",
      [ROUND_LOCK_KEY]
    );

    if (!lock.rows[0].ok) {
      // Cron is creating rounds right now.
      await client.query("ROLLBACK");
      return;
    }

    await client.query(`
      INSERT INTO public.game_rounds (
        round_code, status, starts_at, betting_closes_at, ends_at
      )
      SELECT
        to_char(s AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS'),
        CASE WHEN s + INTERVAL '150 seconds' <= NOW()
             THEN 'locked' ELSE 'open' END,
        s,
        s + INTERVAL '150 seconds',
        s + INTERVAL '180 seconds'
      FROM (
        SELECT to_timestamp(
          (FLOOR(EXTRACT(EPOCH FROM NOW()) / 180) * 180 + 180 * g)
            ::double precision
        ) AS s
        FROM generate_series(0, 5) AS g
      ) slots
      ON CONFLICT (round_code) DO NOTHING
    `);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("ensureRounds error:", error.message);
  }
}

// Settles rounds whose end time has passed.
// settle_expired_round() is idempotent (row lock + SKIP LOCKED),
// so running it here together with cron cannot pay twice.
async function settleDueRounds(client) {
  try {
    const due = await client.query(
      `SELECT 1
       FROM public.game_rounds
       WHERE status IN ('open', 'locked')
         AND ends_at <= NOW()
         AND result_number IS NULL
         AND settled_at IS NULL
       LIMIT 1`
    );

    if (!due.rowCount) return;

    for (let attempt = 0; attempt < 3; attempt++) {
      const settlement = await client.query(
        "SELECT public.settle_expired_round() AS settled_round"
      );

      const result = settlement.rows[0]?.settled_round;

      if (!result || typeof result !== "object" || !result.round_code) {
        break;
      }
    }
  } catch (error) {
    // Never fail the page because of settlement; cron is the backup.
    console.error("Lazy settlement error:", error.message);
  }
}

function verifyTelegramInitData(initData) {
  try {
    if (!initData || !process.env.TELEGRAM_BOT_TOKEN) {
      return null;
    }

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");
    const authDate = Number(params.get("auth_date"));

    if (!receivedHash || !Number.isFinite(authDate)) {
      return null;
    }

    if (Math.abs(Date.now() / 1000 - authDate) > 3600) {
      return null;
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (!/^[0-9a-f]{64}$/i.test(receivedHash)) {
      return null;
    }

    const received = Buffer.from(receivedHash, "hex");
    const calculated = Buffer.from(calculatedHash, "hex");

    if (
      received.length !== calculated.length ||
      !crypto.timingSafeEqual(received, calculated)
    ) {
      return null;
    }

    const user = JSON.parse(params.get("user") || "{}");

    return user.id ? user : null;
  } catch (error) {
    console.error("Telegram verification error:", error.message);
    return null;
  }
}

async function getUser(client, telegramUser) {
  const result = await client.query(
    `INSERT INTO public.users (telegram_id, username)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id)
     DO UPDATE SET username = EXCLUDED.username
     RETURNING id, telegram_id, username, referral_code, referred_by`,
    [String(telegramUser.id), telegramUser.username || null]
  );

  const user = result.rows[0];

  await client.query(
    `INSERT INTO public.wallet_balances (user_id, balance)
     VALUES ($1, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id]
  );

  if (!user.referral_code) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = crypto.randomBytes(8).toString("hex").toUpperCase();

      try {
        const codeResult = await client.query(
          `UPDATE public.users
           SET referral_code = $2
           WHERE id = $1
             AND referral_code IS NULL
           RETURNING referral_code`,
          [user.id, code]
        );

        if (codeResult.rows.length) {
          user.referral_code = codeResult.rows[0].referral_code;
          break;
        }

        const existing = await client.query(
          `SELECT referral_code
           FROM public.users
           WHERE id = $1`,
          [user.id]
        );

        user.referral_code = existing.rows[0]?.referral_code || null;

        if (user.referral_code) break;
      } catch (error) {
        if (error.code !== "23505" || attempt === 2) throw error;
      }
    }
  }

  return user;
}

function validRequestId(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function telegramBotUsername() {
  return String(process.env.TELEGRAM_BOT_USERNAME || "")
    .trim()
    .replace(/^@/, "");
}

async function getReferralData(client, userId) {
  const userResult = await client.query(
    `SELECT id, referral_code, referred_by
     FROM public.users
     WHERE id = $1`,
    [userId]
  );

  const profile = userResult.rows[0];

  if (!profile) {
    throw new Error("User not found.");
  }

  const referralCounts = await client.query(
    `WITH RECURSIVE tree AS (
       SELECT id, 1 AS level FROM public.users WHERE referred_by = $1
       UNION ALL
       SELECT u.id, tree.level + 1
       FROM public.users u JOIN tree ON u.referred_by = tree.id
       WHERE tree.level < 3
     )
     SELECT COUNT(*) FILTER (WHERE level = 1)::int AS level_1,
            COUNT(*) FILTER (WHERE level = 2)::int AS level_2,
            COUNT(*) FILTER (WHERE level = 3)::int AS level_3,
            COUNT(*)::int AS total_referrals
     FROM tree`,
    [userId]
  );

  const directReferrals = await client.query(
    `SELECT id, username, created_at
     FROM public.users
     WHERE referred_by = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
    [userId]
  );

  const commissionTotals = await client.query(
    `SELECT
       referral_level,
       COUNT(*)::int AS commission_count,
       COALESCE(SUM(commission_amount), 0)::numeric(20,2)
         AS total_commission
     FROM public.referral_commissions
     WHERE referrer_user_id = $1
     GROUP BY referral_level
     ORDER BY referral_level`,
    [userId]
  );

  const commissionHistory = await client.query(
    `SELECT
       rc.id,
       rc.bet_id,
       rc.source_user_id,
       rc.referral_level,
       rc.fee_amount,
       rc.commission_rate,
       rc.commission_amount,
       rc.created_at,
       b.bet_type,
       b.selection,
       b.stake,
       r.round_code
     FROM public.referral_commissions rc
     LEFT JOIN public.bets b
       ON b.id = rc.bet_id
     LEFT JOIN public.game_rounds r
       ON r.id = b.round_id
     WHERE rc.referrer_user_id = $1
     ORDER BY rc.id DESC
     LIMIT 50`,
    [userId]
  );

  const rewardSummary = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::int
         AS pending_count,
       COUNT(*) FILTER (WHERE status = 'credited')::int
         AS credited_count,
       COALESCE(
         SUM(reward_points) FILTER (WHERE status = 'pending'),
         0
       )::numeric(20,2) AS pending_points,
       COALESCE(
         SUM(reward_points) FILTER (WHERE status = 'credited'),
         0
       )::numeric(20,2) AS credited_points
     FROM public.referral_rewards
     WHERE referrer_user_id = $1`,
    [userId]
  );

  const walletResult = await client.query(
    `SELECT balance
     FROM public.wallet_balances
     WHERE user_id = $1`,
    [userId]
  );

  const botUsername = telegramBotUsername();

  const referralLink =
    botUsername && profile.referral_code
      ? `https://t.me/${botUsername}?start=ref_${encodeURIComponent(
          profile.referral_code
        )}`
      : null;

  const levels = [1, 2, 3].map((level) => {
    const row = commissionTotals.rows.find(
      (item) => Number(item.referral_level) === level
    );

    return {
      level,
      rate_percent: level === 1 ? 15 : level === 2 ? 10 : 5,
      commission_count: Number(row?.commission_count || 0),
      total_commission: String(row?.total_commission || "0.00"),
    };
  });

  return {
    success: true,
    referral: {
      referral_code: profile.referral_code,
      referral_link: referralLink,
      bot_username: botUsername || null,
      referred_by: profile.referred_by,
      total_direct_referrals: Number(referralCounts.rows[0]?.level_1 || 0),
      team_levels: [1, 2, 3].map((level) => ({
        level,
        count: Number(referralCounts.rows[0]?.[`level_${level}`] || 0),
      })),
      total_team_members: Number(referralCounts.rows[0]?.total_referrals || 0),
      commission_levels: levels,
      total_commission: levels
        .reduce((sum, level) => sum + Number(level.total_commission), 0)
        .toFixed(2),
      reward: {
        reward_per_eligible_referral: 100,
        qualifying_recharge_points: 100,
        recharge_system_enabled: true,
        pending_count: Number(
          rewardSummary.rows[0]?.pending_count || 0
        ),
        credited_count: Number(
          rewardSummary.rows[0]?.credited_count || 0
        ),
        pending_points: String(
          rewardSummary.rows[0]?.pending_points || "0.00"
        ),
        credited_points: String(
          rewardSummary.rows[0]?.credited_points || "0.00"
        ),
        message:
          "Rewards require a confirmed qualifying recharge. Recharge is not enabled yet.",
      },
      wallet_balance: String(walletResult.rows[0]?.balance ?? "0.00"),
      direct_referrals: directReferrals.rows.map((row) => ({
        username: row.username,
        created_at: row.created_at,
      })),
      commission_history: commissionHistory.rows,
    },
  };
}

// Direct referrals with active/inactive status and reward status.
// Active = placed at least one bet in the last 7 days.
async function getReferralMembers(client, userId) {
  const members = await client.query(
    `SELECT
       u.id,
       u.username,
       u.created_at,
       EXISTS (
         SELECT 1 FROM public.bets b
         WHERE b.user_id = u.id
           AND b.created_at > NOW() - INTERVAL '7 days'
       ) AS is_active,
       (SELECT MAX(b.created_at) FROM public.bets b
         WHERE b.user_id = u.id) AS last_bet_at,
       rr.status AS reward_status,
       rr.reward_points::text AS reward_points,
       rr.credited_at
     FROM public.users u
     LEFT JOIN public.referral_rewards rr
       ON rr.referred_user_id = u.id
      AND rr.referrer_user_id = $1
     WHERE u.referred_by = $1
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT 100`,
    [userId]
  );

  const summary = await client.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM public.bets b
         WHERE b.user_id = u.id
           AND b.created_at > NOW() - INTERVAL '7 days'
       ))::int AS active,
       COUNT(*) FILTER (WHERE rr.status = 'pending')::int AS pending_count,
       COALESCE(SUM(rr.reward_points)
         FILTER (WHERE rr.status = 'pending'), 0)::text AS pending_points,
       COUNT(*) FILTER (WHERE rr.status = 'credited')::int AS credited_count,
       COALESCE(SUM(rr.reward_points)
         FILTER (WHERE rr.status = 'credited'), 0)::text AS credited_points
     FROM public.users u
     LEFT JOIN public.referral_rewards rr
       ON rr.referred_user_id = u.id
      AND rr.referrer_user_id = $1
     WHERE u.referred_by = $1`,
    [userId]
  );

  return {
    success: true,
    summary: summary.rows[0],
    members: members.rows,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // GET: current round and results that are safe to display.
  if (req.method === "GET") {
    const { page, pageSize, offset } = pageParams(req.query || {});
    let client;

    try {
      client = await pool.connect();

      // Rounds must exist and finished rounds must be settled
      // before we answer, so players never wait for cron.
      await ensureRounds(client);
      await settleDueRounds(client);

      const timeResult = await client.query(
        "SELECT NOW() AS server_time"
      );

      // Only expose results after the round's scheduled end time.
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM public.game_rounds
         WHERE status = 'settled'
           AND result_number IS NOT NULL
           AND ends_at <= NOW()`
      );

      const roundsResult = await client.query(
        `SELECT id, round_code, status, starts_at,
                betting_closes_at, ends_at,
                result_number, created_at, settled_at
         FROM public.game_rounds
         WHERE status = 'settled'
           AND result_number IS NOT NULL
           AND ends_at <= NOW()
         ORDER BY starts_at DESC
         LIMIT $1 OFFSET $2`,
        [pageSize, offset]
      );

      const currentResult = await client.query(
        `SELECT id, round_code, status, starts_at,
                betting_closes_at, ends_at
         FROM public.game_rounds
         WHERE starts_at <= NOW()
           AND ends_at > NOW()
         ORDER BY starts_at DESC
         LIMIT 1`
      );

      const total = Number(countResult.rows[0].total);

      return json(res, 200, {
        success: true,
        server_time: timeResult.rows[0].server_time,
        current_round: currentResult.rows[0] || null,
        rounds: roundsResult.rows,
        rounds_page: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.max(1, Math.ceil(total / pageSize)),
          has_next: offset + pageSize < total,
          has_previous: page > 1,
        },
      });
    } catch (error) {
      console.error("GET /api/game:", error);

      return json(res, 500, {
        success: false,
        message: "Unable to load game data.",
      });
    } finally {
      if (client) client.release();
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return json(res, 405, {
      success: false,
      message: "Method not allowed.",
    });
  }

  const body = req.body || {};
  const telegramUser = verifyTelegramInitData(body.initData);

  if (!telegramUser) {
    return json(res, 401, {
      success: false,
      message: "Telegram authentication failed. Reopen the app.",
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    const user = await getUser(client, telegramUser);
    await client.query(`ALTER TABLE public.referral_commissions ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
    const action = String(body.action || "");

    if (action === "balance") {
      const result = await client.query(
        `SELECT balance
         FROM public.wallet_balances
         WHERE user_id = $1`,
        [user.id]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return json(res, 200, {
        success: true,
        balance: result.rows[0]?.balance ?? "0.00",
      });
    }

    if (action === "my_bets") {
      const { page, pageSize, offset } = pageParams(body);

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM public.bets
         WHERE user_id = $1`,
        [user.id]
      );

      // Hide the result and settlement information until the round ends.
      const result = await client.query(
        `SELECT
           b.id,
           b.bet_type,
           b.selection,
           b.stake,
           b.fee,
           CASE
             WHEN r.ends_at <= NOW() THEN b.status
             ELSE 'pending'
           END AS status,
           CASE
             WHEN r.ends_at <= NOW() THEN b.payout
             ELSE 0
           END AS payout,
           b.created_at,
           CASE
             WHEN r.ends_at <= NOW() THEN b.settled_at
             ELSE NULL
           END AS settled_at,
           r.round_code,
           CASE
             WHEN r.ends_at <= NOW() THEN r.result_number
             ELSE NULL
           END AS result_number
         FROM public.bets b
         JOIN public.game_rounds r
           ON r.id = b.round_id
         WHERE b.user_id = $1
         ORDER BY b.id DESC
         LIMIT $2 OFFSET $3`,
        [user.id, pageSize, offset]
      );

      const total = Number(countResult.rows[0].total);

      await client.query("COMMIT");
      transactionStarted = false;

      return json(res, 200, {
        success: true,
        bets: result.rows,
        pagination: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.max(1, Math.ceil(total / pageSize)),
          has_next: offset + pageSize < total,
          has_previous: page > 1,
        },
      });
    }

    if (action === "wallet_config") {
      await client.query("COMMIT"); transactionStarted = false;
      return json(res, 200, {
        success: true,
        deposit_address: process.env.USDT_BEP20_DEPOSIT_ADDRESS || null,
        token_address: process.env.USDT_BEP20_TOKEN_ADDRESS || null,
        network: "BSC BEP-20",
        min_deposit_points: MIN_DEPOSIT_POINTS,
        min_withdraw_points: MIN_WITHDRAW_POINTS,
        points_per_usdt: POINTS_PER_USDT
      });
    }

    if (action === "request_withdrawal") {
      const amountText = String(body.amount || "").trim();
      const amount = Number(amountText);
      const destination = String(body.destination_address || "").trim().toLowerCase();
      if (!/^\d{1,18}(\.\d{1,2})?$/.test(amountText) || !Number.isFinite(amount) || amount < MIN_WITHDRAW_POINTS) {
        await client.query("ROLLBACK"); transactionStarted = false;
        return json(res, 400, { success: false, message: "Minimum withdrawal is 500 points (5 USDT)." });
      }
      if (!/^0x[a-f0-9]{40}$/.test(destination)) {
        await client.query("ROLLBACK"); transactionStarted = false;
        return json(res, 400, { success: false, message: "Enter a valid BSC wallet address." });
      }
      const result = await client.query(
        `UPDATE public.wallet_balances
         SET balance = balance - $1::numeric, updated_at = NOW()
         WHERE user_id = $2 AND balance >= $1::numeric
         RETURNING balance`, [amount.toFixed(2), user.id]
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK"); transactionStarted = false;
        return json(res, 400, { success: false, message: "Insufficient available balance." });
      }
      const tx = await client.query(
        `INSERT INTO public.transactions
          (user_id, transaction_type, amount, status, network, destination_address, created_at, updated_at)
         VALUES ($1, 'withdrawal', $2, 'pending', 'BSC', $3, NOW(), NOW())
         RETURNING id, amount, status, destination_address, created_at`,
        [user.id, amount.toFixed(2), destination]
      );
      await client.query("COMMIT"); transactionStarted = false;
      return json(res, 200, { success: true, withdrawal: tx.rows[0], balance: result.rows[0].balance });
    }

    if (action === "wallet_history") {
      const { page, pageSize, offset } = pageParams(body);

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM public.transactions
         WHERE user_id = $1`,
        [user.id]
      );

      const result = await client.query(
        `SELECT id, transaction_type, amount, status,
                network, tx_hash, created_at, updated_at
         FROM public.transactions
         WHERE user_id = $1
         ORDER BY id DESC
         LIMIT $2 OFFSET $3`,
        [user.id, pageSize, offset]
      );

      const total = Number(countResult.rows[0].total);

      await client.query("COMMIT");
      transactionStarted = false;

      return json(res, 200, {
        success: true,
        transactions: result.rows,
        pagination: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.max(1, Math.ceil(total / pageSize)),
          has_next: offset + pageSize < total,
          has_previous: page > 1,
        },
      });
    }

    if (action === "referral_data") {
      const data = await getReferralData(client, user.id);

      await client.query("COMMIT");
      transactionStarted = false;

      return json(res, 200, data);
    }

    if (action === "apply_referral") {
      const referralCode = String(body.referral_code || "").trim();

      if (!referralCode || referralCode.length > 100) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return json(res, 400, {
          success: false,
          message: "Enter a valid referral code.",
        });
      }

      const result = await client.query(
        `SELECT public.apply_referral_code($1::bigint, $2::text) AS result`,
        [user.id, referralCode]
      );

      const data = result.rows[0]?.result;

      if (!data || data.success !== true) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return json(res, 400, {
          success: false,
          message: data?.message || "Unable to apply referral code.",
        });
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return json(res, 200, data);
    }

    if (action === "referral_history") {
      const { page, pageSize, offset } = pageParams(body);

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM public.referral_commissions
         WHERE referrer_user_id = $1`,
        [user.id]
      );

      const result = await client.query(
        `SELECT
           rc.id,
           rc.bet_id,
           rc.source_user_id,
           rc.referral_level,
           rc.fee_amount,
           rc.commission_rate,
           rc.commission_amount,
           rc.created_at,
           b.bet_type,
           b.selection,
           b.stake,
           r.round_code
         FROM public.referral_commissions rc
         LEFT JOIN public.bets b ON b.id = rc.bet_id
         LEFT JOIN public.game_rounds r ON r.id = b.round_id
         WHERE rc.referrer_user_id = $1
         ORDER BY rc.id DESC
         LIMIT $2 OFFSET $3`,
        [user.id, pageSize, offset]
      );

      const total = Number(countResult.rows[0].total);

      await client.query("COMMIT");
      transactionStarted = false;

      return json(res, 200, {
        success: true,
        commissions: result.rows,
        pagination: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.max(1, Math.ceil(total / pageSize)),
          has_next: offset + pageSize < total,
          has_previous: page > 1,
        },
      });
    }

    if (action === "referral_members") {
      const data = await getReferralMembers(client, user.id);

      await client.query("COMMIT");
      transactionStarted = false;

      return json(res, 200, data);
    }

    if (action === "claim_commission") {
      const claim = await client.query(
        `WITH claimable AS (
           SELECT COALESCE(SUM(commission_amount), 0) AS amount
           FROM public.referral_commissions
           WHERE referrer_user_id = $1 AND claimed_at IS NULL
         ), marked AS (
           UPDATE public.referral_commissions
           SET claimed_at = NOW()
           WHERE referrer_user_id = $1 AND claimed_at IS NULL
           RETURNING commission_amount
         )
         SELECT (SELECT amount FROM claimable)::numeric(20,2) AS amount`,
        [user.id]
      );
      const amount = Number(claim.rows[0]?.amount || 0);
      if (amount <= 0) {
        await client.query("ROLLBACK"); transactionStarted = false;
        return json(res, 400, { success: false, message: "No commission is available to claim." });
      }
      await client.query(
        `UPDATE public.wallet_balances SET balance = balance + $1 WHERE user_id = $2`,
        [amount.toFixed(2), user.id]
      );
      await client.query("COMMIT"); transactionStarted = false;
      return json(res, 200, { success: true, claimed_points: amount.toFixed(2) });
    }

    if (action === "place_bet") {
      const roundCode = String(body.round_code || "");
      const betType = String(body.bet_type || "");
      const requestId = String(body.request_id || "");
      const stakeText = String(body.stake ?? "").trim();
      const stake = Number(stakeText);

      const selection =
        body.selection === null || body.selection === undefined
          ? null
          : Number(body.selection);

      if (!/^\d{14}$/.test(roundCode)) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return json(res, 400, {
          success: false,
          message: "Invalid round code. Expected YYYYMMDDHHMMSS.",
        });
      }

      if (!validRequestId(requestId)) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return json(res, 400, {
          success: false,
          message: "Invalid request ID. Please retry.",
        });
      }

      if (
        !/^\d{1,18}(\.\d{1,2})?$/.test(stakeText) ||
        !Number.isFinite(stake) ||
        stake < MIN_BET_POINTS
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return json(res, 400, {
          success: false,
          message:
            "Stake must be at least 10 points, with maximum 2 decimals.",
        });
      }

      if (!BET_TYPES.includes(betType)) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return json(res, 400, {
          success: false,
          message: "Invalid bet type.",
        });
      }

      if (
        (betType === "Number" &&
          (!Number.isInteger(selection) ||
            selection < 0 ||
            selection > 9)) ||
        (betType !== "Number" && selection !== null)
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return json(res, 400, {
          success: false,
          message: "Invalid selection.",
        });
      }

      const result = await client.query(
        `SELECT public.place_bet_atomic(
           $1::bigint,
           $2::text,
           $3::text,
           $4::smallint,
           $5::numeric,
           $6::uuid
         ) AS result`,
        [
          user.id,
          roundCode,
          betType,
          selection,
          stake.toFixed(2),
          requestId,
        ]
      );

      const data = result.rows[0].result;
      const success =
        data?.success === true || data?.success === "true";

      if (!success) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return json(res, 400, {
          ...(data && typeof data === "object" ? data : {}),
          success: false,
          message: data?.message || "Bet could not be placed.",
        });
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return json(res, 200, data);
    }

    await client.query("ROLLBACK");
    transactionStarted = false;

    return json(res, 400, {
      success: false,
      message: "Unknown action.",
    });
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("POST /api/game:", error);

    return json(res, 500, {
      success: false,
      message: "Game request failed. Please try again.",
    });
  } finally {
    if (client) client.release();
  }
};
