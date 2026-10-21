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
const ALLOWED_MULTIPLIERS = [1, 3, 9, 27, 81]; // NEW: Multiplier validation
const POINTS_PER_USDT = 100;
const MIN_BET_POINTS = 10;
const MIN_DEPOSIT_POINTS = 100;
const MIN_WITHDRAW_POINTS = 500;
const ROUND_LOCK_KEY = 739184205; // same lock key as api/cron.js
const RESULTS_CHANNEL = "@crypto_trader_results";

// ============================================================================
// SAFE ETHERS LOADER (Prevents 500 errors on server crash)
// ============================================================================
let _ethers = null;
let _provider = null;

function getEthers() {
  if (!_ethers) {
    try {
      _ethers = require("ethers");
    } catch (e) {
      console.error("[FATAL] ethers not installed:", e.message);
      throw new Error("Blockchain library not available. Please check package.json.");
    }
  }
  return _ethers;
}

function getProvider() {
  if (!_provider) {
    const ethers = getEthers();
    _provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org");
  }
  return _provider;
}
// ============================================================================

async function notifyTelegram(text, chats = [process.env.ADMIN_CHAT_ID]) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await Promise.allSettled(chats.filter(Boolean).map((chatId) => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10000)
  })));
}

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

// ============================================================================
// NEW: App Settings Helpers (For Admin Panel & Header Buttons)
// ============================================================================
async function ensureAppSettings(client) {
  await client.query("SAVEPOINT sp_app_settings");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    
    const defaults = [
      ['sound_button_enabled', 'true'],
      ['channel_button_enabled', 'false'],
      ['channel_url', ''],
      ['support_button_enabled', 'false'],
      ['support_url', ''],
      ['support_type', 'whatsapp'],
      ['signup_bonus_enabled', 'true'],
      ['signup_bonus_amount', '25'],
    ];
    
    for (const [key, value] of defaults) {
      await client.query(
        `INSERT INTO public.app_settings (key, value) 
         VALUES ($1, $2) 
         ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }
    await client.query("RELEASE SAVEPOINT sp_app_settings");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT sp_app_settings");
    console.warn("App settings setup skipped:", err.message);
  }
}

async function getAppSetting(client, key, fallback = null) {
  try {
    const r = await client.query(
      `SELECT value FROM public.app_settings WHERE key = $1`, 
      [key]
    );
    if (!r.rowCount) return fallback;
    return r.rows[0].value;
  } catch (_) {
    return fallback;
  }
}

function parseSettingValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  if (!isNaN(Number(raw)) && String(raw).trim() !== '') return Number(raw);
  return raw;
}
// ============================================================================

// ============================================================================
// NEW: BEP-20 Auto-Deposit Verification (Via Direct RPC Node)
// ============================================================================
async function verifyBEP20Deposit(txHash, expectedAmountUsdt) {
  const usdtContract = (process.env.USDT_BEP20_TOKEN_ADDRESS || "0x55d398326f99059fF775485246999027B3197955").toLowerCase();
  const depositAddress = String(process.env.USDT_BEP20_DEPOSIT_ADDRESS || "").toLowerCase();

  if (!depositAddress) {
    console.warn("Deposit Address missing in .env");
    return { success: false, reason: "Server configuration missing" };
  }

  try {
    const ethers = getEthers();
    const provider = getProvider();

    // 1. Fetch receipt
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return { success: false, reason: "Transaction not found on Blockchain yet. Please wait." };
    }
    if (receipt.status !== 1) {
      return { success: false, reason: "Transaction failed on the blockchain." };
    }

    // 2. Fetch transaction details
    const tx = await provider.getTransaction(txHash);

    // 3. Check Transfer logs
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    const log = receipt.logs.find(l => 
      l.address.toLowerCase() === usdtContract &&
      l.topics[0] === transferTopic &&
      l.topics[2] && ethers.getAddress("0x" + l.topics[2].slice(26)).toLowerCase() === depositAddress
    );

    if (!log) {
      return { success: false, reason: "Transaction was not sent to the official deposit address." };
    }

    // 4. Decode amount
    const onChainAmount = Number(ethers.formatUnits(log.data, 18));

    if (onChainAmount + 0.01 < expectedAmountUsdt) {
      return { success: false, reason: `Amount mismatch. You sent ${onChainAmount} USDT but entered ${expectedAmountUsdt} USDT.` };
    }

    return { success: true, verifiedAmount: onChainAmount, fromAddress: tx.from };

  } catch (error) {
    console.error("Blockchain verify error:", error.message);
    return { success: false, reason: "Blockchain network error. Submitted for manual review." };
  }
}
// ============================================================================

// Makes sure the current round and a few future rounds exist,
// so the game never depends on the cron timing.
// Safe to run many times: unique round_code + advisory lock.
async function ensureRounds(client) {
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.game_rounds (
      id BIGSERIAL PRIMARY KEY,
      round_code TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      starts_at TIMESTAMPTZ NOT NULL,
      betting_closes_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      result_number INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ
    )`);
    await client.query(`ALTER TABLE public.game_rounds ADD COLUMN IF NOT EXISTS betting_closes_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE public.game_rounds ADD COLUMN IF NOT EXISTS result_number INTEGER`);
    await client.query(`ALTER TABLE public.game_rounds ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await client.query(`ALTER TABLE public.game_rounds ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ`);
    
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

    // Increased to 24 hours to prevent sudden logouts
    if (Math.abs(Date.now() / 1000 - authDate) > 86400) {
      return null;
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
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
  await client.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS first_name TEXT`);
  await client.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_name TEXT`);
  await client.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS signup_bonus_given BOOLEAN NOT NULL DEFAULT FALSE`); 
  await client.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deposit_wallet TEXT`); 
  await client.query(`ALTER TABLE public.referral_rewards ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ`);
  
  const result = await client.query(
    `INSERT INTO public.users (telegram_id, username, first_name, last_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id)
       DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name
       RETURNING id, telegram_id, username, first_name, last_name, referral_code, referred_by, signup_bonus_given, deposit_wallet, (xmax = 0) AS is_new`,
    [String(telegramUser.id), telegramUser.username || null, telegramUser.first_name || null, telegramUser.last_name || null]
  );

  const user = result.rows[0];

  await client.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE`);
  await client.query(`CREATE TABLE IF NOT EXISTS public.user_notifications (
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS public.gift_codes (
    id BIGSERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, points NUMERIC(20,2) NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, expires_at TIMESTAMPTZ,
    created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  
  await client.query(`CREATE TABLE IF NOT EXISTS public.gift_code_redemptions (
    gift_code_id BIGINT REFERENCES public.gift_codes(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES public.users(id) ON DELETE CASCADE,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(gift_code_id, user_id)
  )`);

  await client.query(
    `INSERT INTO public.wallet_balances (user_id, balance)
     VALUES ($1, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id]
  );

  if (user.is_new && !user.signup_bonus_given) {
    const enabledRaw = await getAppSetting(client, "signup_bonus_enabled", "true");
    const amountRaw = await getAppSetting(client, "signup_bonus_amount", "25");
    const bonusEnabled = enabledRaw === "true" || enabledRaw === "1";
    const bonusAmount = Number(amountRaw) || 0;

    if (bonusEnabled && bonusAmount > 0) {
      await client.query(
        `UPDATE public.wallet_balances SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2`,
        [bonusAmount, user.id]
      );
      await client.query(
        `UPDATE public.users SET signup_bonus_given = TRUE WHERE id = $1`,
        [user.id]
      );

      await client.query("SAVEPOINT sp_bonus_tx");
      try {
        await client.query(
          `INSERT INTO public.transactions (user_id, transaction_type, amount, status, created_at, updated_at)
           VALUES ($1, 'reward', $2, 'completed', NOW(), NOW())`,
          [user.id, bonusAmount.toFixed(2)]
        );
        await client.query("RELEASE SAVEPOINT sp_bonus_tx");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT sp_bonus_tx");
        console.warn("Signup bonus txn insert skipped:", err.message);
      }

      await client.query("SAVEPOINT sp_bonus_notif");
      try {
        await client.query(
          `INSERT INTO public.user_notifications(user_id,kind,title,message)
           VALUES($1,'bonus','Joining bonus',$2)`,
          [user.id, `You received ${bonusAmount} points as a new user joining bonus.`]
        );
        await client.query("RELEASE SAVEPOINT sp_bonus_notif");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT sp_bonus_notif");
        console.warn("Signup bonus notif skipped:", err.message);
      }
    } else {
      await client.query(
        `UPDATE public.users SET signup_bonus_given = TRUE WHERE id = $1`,
        [user.id]
      );
    }
  }

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

// ============================================================================
// Auto-credit pending rewards for active users
// ============================================================================
async function autoCreditReferralRewards(client, referrerUserId) {
  await client.query("SAVEPOINT sp_auto_credit");
  try {
    const check = await client.query(`
      SELECT COUNT(*)::int AS cnt FROM public.referral_rewards rr
      WHERE rr.referrer_user_id = $1 AND rr.status = 'pending'
        AND EXISTS (SELECT 1 FROM public.bets b WHERE b.user_id = rr.referred_user_id AND b.created_at > NOW() - INTERVAL '7 days')
    `, [referrerUserId]);
    
    if (check.rows[0].cnt === 0) {
      await client.query("RELEASE SAVEPOINT sp_auto_credit");
      return 0;
    }

    const locked = await client.query(`
      SELECT rr.id, rr.reward_points FROM public.referral_rewards rr
      WHERE rr.referrer_user_id = $1 AND rr.status = 'pending'
        AND EXISTS (SELECT 1 FROM public.bets b WHERE b.user_id = rr.referred_user_id AND b.created_at > NOW() - INTERVAL '7 days')
      FOR UPDATE
    `, [referrerUserId]);
    
    if (!locked.rowCount) {
      await client.query("RELEASE SAVEPOINT sp_auto_credit");
      return 0;
    }

    const total = locked.rows.reduce((sum, r) => sum + Number(r.reward_points), 0);
    const ids = locked.rows.map(r => r.id);

    await client.query(`UPDATE public.referral_rewards SET status = 'credited', credited_at = NOW() WHERE id = ANY($1::bigint[])`, [ids]);
    await client.query(`UPDATE public.wallet_balances SET balance = balance + $1 WHERE user_id = $2`, [total.toFixed(2), referrerUserId]);
    
    await client.query("SAVEPOINT sp_auto_tx");
    try {
      await client.query(
        `INSERT INTO public.transactions (user_id, transaction_type, amount, status, created_at, updated_at)
         VALUES ($1, 'reward', $2, 'completed', NOW(), NOW())`,
        [referrerUserId, total.toFixed(2)]
      );
      await client.query("RELEASE SAVEPOINT sp_auto_tx");
    } catch(e) {
      await client.query("ROLLBACK TO SAVEPOINT sp_auto_tx");
    }

    await client.query("RELEASE SAVEPOINT sp_auto_credit");
    return total;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT sp_auto_credit");
    console.warn("Auto credit skipped:", err.message);
    return 0;
  }
}
// ============================================================================

async function getReferralData(client, userId) {
  await autoCreditReferralRewards(client, userId);

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
       COALESCE(SUM(commission_amount) FILTER (WHERE claimed_at IS NULL), 0)::numeric(20,2)
         AS total_commission,
       COALESCE(SUM(commission_amount) FILTER (WHERE claimed_at IS NOT NULL), 0)::numeric(20,2)
         AS claimed_commission
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
         SUM(rr.reward_points) FILTER (WHERE rr.status = 'pending'),
         0
       )::numeric(20,2) AS pending_points,
       COALESCE(
         SUM(rr.reward_points) FILTER (WHERE rr.status = 'credited'),
         0
       )::numeric(20,2) AS credited_points
     FROM public.referral_rewards rr
     WHERE rr.referrer_user_id = $1`,
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
      claimed_commission: String(row?.claimed_commission || "0.00"),
    };
  });

  const claimedCommission = commissionTotals.rows.reduce(
    (sum, row) => sum + Number(row.claimed_commission || 0),
    0
  );

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
      claimed_commission: claimedCommission.toFixed(2),
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
          "Earn 100 points for each direct referral after their qualifying recharge of 100 points is confirmed.",
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

async function getReferralMembers(client, userId) {
  await autoCreditReferralRewards(client, userId);

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

  if (req.method === "GET") {
    const { page, pageSize, offset } = pageParams(req.query || {});
    let client;

    try {
      client = await pool.connect();

      await ensureRounds(client);
      await settleDueRounds(client);

      const timeResult = await client.query(
        "SELECT NOW() AS server_time"
      );

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
        error_code: error.code || "GAME_BACKEND_ERROR",
        detail: error.message,
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

    await ensureAppSettings(client); 
    const user = await getUser(client, telegramUser);
    await client.query(`ALTER TABLE public.referral_commissions ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
    const action = String(body.action || "");

    if (action === "app_config") {
      const rows = await client.query(`SELECT key, value FROM public.app_settings`);
      const config = {
        sound_button_enabled: true,
        channel_button_enabled: false,
        channel_url: "",
        support_button_enabled: false,
        support_url: "",
        support_type: "whatsapp",
        signup_bonus_enabled: true,
        signup_bonus_amount: 25,
      };
      rows.rows.forEach(row => {
        const parsed = parseSettingValue(row.value);
        if (parsed !== null) config[row.key] = parsed;
      });
      await client.query("COMMIT"); transactionStarted = false;
      return json(res, 200, { success: true, config });
    }

    if (action === "balance") {
      const result = await client.query(
        `SELECT wb.balance, u.deposit_wallet
         FROM public.wallet_balances wb
         JOIN public.users u ON u.id = wb.user_id
         WHERE wb.user_id = $1`,
        [user.id]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return json(res, 200, {
        success: true,
        balance: result.rows[0]?.balance ?? "0.00",
        wallet_address: result.rows[0]?.deposit_wallet || null,
      });
    }

    if (action === "notifications") {
      const notifications = await client.query(`SELECT id,kind,title,message,is_read,created_at FROM public.user_notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 50`, [user.id]);
      await client.query(`UPDATE public.user_notifications SET is_read=TRUE WHERE user_id=$1 AND is_read=FALSE`, [user.id]);
      await client.query("COMMIT"); transactionStarted = false;
      return json(res, 200, { success: true, notifications: notifications.rows });
    }

    if (action === "redeem_gift") {
      const code = String(body.code || "").trim().toUpperCase();
      if (!/^[A-Z0-9-]{4,64}$/.test(code)) throw new Error("Enter a valid gift code.");
      const gift = await client.query(
        `SELECT * FROM public.gift_codes
         WHERE UPPER(code)=$1 AND uses < max_uses AND (expires_at IS NULL OR expires_at > NOW())
         FOR UPDATE`,
        [code]
      );
      if (!gift.rowCount) throw new Error("Gift code is invalid, expired, or already used.");
      
      const used = await client.query(
        `SELECT 1 FROM public.gift_code_redemptions WHERE gift_code_id=$1 AND user_id=$2`,
        [gift.rows[0].id, user.id]
      );
      if (used.rowCount) throw new Error("You have already redeemed this gift code.");
      
      await client.query(`INSERT INTO public.gift_code_redemptions(gift_code_id,user_id) VALUES($1,$2)`, [gift.rows[0].id, user.id]);
      await client.query(`UPDATE public.gift_codes SET uses=uses+1 WHERE id=$1`, [gift.rows[0].id]);
      await client.query(`UPDATE public.wallet_balances SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2`, [gift.rows[0].points, user.id]);
      
      await client.query("SAVEPOINT sp_gift_tx");
      try {
        await client.query(
          `INSERT INTO public.transactions (user_id, transaction_type, amount, status, created_at, updated_at)
           VALUES ($1, 'gift', $2, 'completed', NOW(), NOW())`,
          [user.id, gift.rows[0].points]
        );
        await client.query("RELEASE SAVEPOINT sp_gift_tx");
      } catch(e) {
        await client.query("ROLLBACK TO SAVEPOINT sp_gift_tx");
      }

      await client.query(
        `INSERT INTO public.user_notifications(user_id,kind,title,message) VALUES($1,'gift','Gift code redeemed',$2)`,
        [user.id, `You received ${gift.rows[0].points} points.`]
      ).catch(()=>{});
      
      await client.query("COMMIT"); transactionStarted = false;
      return json(res, 200, { success: true, points: gift.rows[0].points });
    }

    if (action === "my_bets") {
      const { page, pageSize, offset } = pageParams(body);

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM public.bets
         WHERE user_id = $1`,
        [user.id]
      );

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
      await client.query(`CREATE TABLE IF NOT EXISTS public.deposit_addresses (
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
      const seedAddress = process.env.USDT_BEP20_DEPOSIT_ADDRESS || "";
      if (seedAddress) {
        await client.query(`INSERT INTO public.deposit_addresses (coin,network,address)
          SELECT 'USDT','BSC BEP-20',$1 WHERE NOT EXISTS (SELECT 1 FROM public.deposit_addresses)`, [seedAddress]);
      }
      const options = await client.query(`SELECT id,coin,network,address,COALESCE(qr_payload,address) AS qr_payload
      FROM public.deposit_addresses WHERE is_active=TRUE ORDER BY sort_order,id LIMIT 10`);
      const rows = options.rows.length ? options.rows : (process.env.USDT_BEP20_DEPOSIT_ADDRESS ? [{ id: "env-usdt-bep20", coin: "USDT", network: "BEP-20", address: process.env.USDT_BEP20_DEPOSIT_ADDRESS, qr_payload: process.env.USDT_BEP20_DEPOSIT_ADDRESS }] : []);
      await client.query("COMMIT"); transactionStarted = false;
      return json(res, 200, {
        success: true,
        deposit_options: rows,
        deposit_address: rows[0]?.address || null,
        token_address: process.env.USDT_BEP20_TOKEN_ADDRESS || null,
        network: rows[0]?.network || "BSC BEP-20",
        min_deposit_points: MIN_DEPOSIT_POINTS,
        min_withdraw_points: MIN_WITHDRAW_POINTS,
        points_per_usdt: POINTS_PER_USDT
      });
    }

    if (action === "submit_deposit") {
      const txHash = String(body.tx_hash || "").trim();
      const amountText = String(body.amount_usdt || "").trim();
      const amount = Number(amountText);
      const network = String(body.network || "Unknown Network").trim().slice(0, 80);
      
      if (txHash.length < 20) {
        await client.query("ROLLBACK"); transactionStarted = false;
        return json(res, 400, { success: false, message: "Enter a valid transaction hash." });
      }
      
      if (!Number.isFinite(amount) || amount < 1 || amount > 1000000) {
        await client.query("ROLLBACK"); transactionStarted = false;
        return json(res, 400, { success: false, message: "Minimum deposit is 1 USDT." });
      }
      
      const existing = await client.query(`SELECT id,status FROM public.transactions WHERE LOWER(tx_hash)=LOWER($1) LIMIT 1`, [txHash]);
      if (existing.rowCount) {
        await client.query("ROLLBACK"); transactionStarted = false;
        return json(res, 409, { success: false, message: "This transaction hash has already been submitted." });
      }

      // 🚀 AUTOMATIC VERIFICATION VIA RPC 🚀
      const verification = await verifyBEP20Deposit(txHash, amount);

      if (verification.success) {
        const pointsToAdd = verification.verifiedAmount * 100;

        const submitted = await client.query(
          `INSERT INTO public.transactions (user_id,transaction_type,amount,status,network,tx_hash,created_at,updated_at) 
           VALUES ($1,'deposit',$2::numeric,'completed',$3,$4,NOW(),NOW()) 
           RETURNING id,amount,status,network,tx_hash,created_at`, 
          [user.id, verification.verifiedAmount.toFixed(6), network, txHash]
        );

        await client.query(`UPDATE public.wallet_balances SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2`, [pointsToAdd, user.id]);
        
        await client.query(`INSERT INTO public.user_notifications(user_id,kind,title,message) VALUES($1,'deposit','Deposit Successful',$2)`, 
          [user.id, `Deposit of ${verification.verifiedAmount} USDT verified automatically. ${pointsToAdd} Points added.`]).catch(() => {});
        
        await client.query("COMMIT"); transactionStarted = false;

        await notifyTelegram(`✅ Auto-Deposit Verified!\n👤 User ID: ${user.telegram_id}\n💵 Amount: ${verification.verifiedAmount} USDT\n🪙 Points: ${pointsToAdd}\n🔗 TX: ${txHash}`);

        return json(res, 200, { 
          success: true, 
          deposit: submitted.rows[0], 
          message: `Auto-verified! ${pointsToAdd} points added.` 
        });

      } else {
        console.warn("Auto-verify failed:", verification.reason);
        
        const submitted = await client.query(
          `INSERT INTO public.transactions (user_id,transaction_type,amount,status,network,tx_hash,created_at,updated_at) 
           VALUES ($1,'deposit',$2::numeric,'pending',$3,$4,NOW(),NOW()) 
           RETURNING id,amount,status,network,tx_hash,created_at`, 
          [user.id, amount.toFixed(6), network, txHash]
        );
        
        await client.query(`INSERT INTO public.user_notifications(user_id,kind,title,message) VALUES($1,'deposit','Deposit pending',$2)`, 
          [user.id, `Auto-verification failed (${verification.reason}). Submitted to admin for manual approval.`]).catch(() => {});
        
        await client.query("COMMIT"); transactionStarted = false;
        
        await notifyTelegram(`⚠️ Manual Verification Needed\n👤 User ID: ${user.telegram_id}\n🔗 TX: ${txHash}\n🌐 Network: ${network}\n❌ Reason: ${verification.reason}`);
        
        return json(res, 200, { success: true, deposit: submitted.rows[0], message: "Submitted for admin approval. Auto-verify is pending." });
      }
    }

    if (action === "request_withdrawal") {
      const amountText = String(body.amount || "").trim();
      const amount = Number(amountText);
      const destination = String(body.destination_address || "").trim();
      const withdrawalFeeRate = 0.10;
      
      if (!/^\d{1,18}(\.\d{1,2})?$/.test(amountText) || !Number.isFinite(amount) || amount < MIN_WITHDRAW_POINTS) {
        await client.query("ROLLBACK"); transactionStarted = false;
        return json(res, 400, { success: false, message: "Minimum withdrawal is 500 points (5 USDT)." });
      }
      
      if (destination.length < 20) {
        await client.query("ROLLBACK"); transactionStarted = false;
        return json(res, 400, { success: false, message: "Enter a valid wallet address." });
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
      
      const netPoints = Math.floor(amount * (1 - withdrawalFeeRate) * 100) / 100;
      const netAmountUsdt = (netPoints / POINTS_PER_USDT).toFixed(6);
      
      const grossAmountUsdt = (amount / POINTS_PER_USDT).toFixed(6);
      
      const tx = await client.query(
        `INSERT INTO public.transactions
          (user_id, transaction_type, amount, status, network, destination_address, created_at, updated_at)
         VALUES ($1, 'withdrawal', $2, 'pending', 'BSC', $3, NOW(), NOW())
         RETURNING id, amount, status, destination_address, created_at`,
        [user.id, grossAmountUsdt, destination]
      );
      
      await client.query("COMMIT"); transactionStarted = false;
      const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ") || "User";
      await notifyTelegram(`📤 Withdrawal requested\n👤 Name: ${displayName}\n💵 Gross: ${(amount / POINTS_PER_USDT).toFixed(2)} USDT\n💸 Fee: 10%\n✅ Net: ${netAmountUsdt} USDT\n🏦 Wallet: ${destination}\n⏳ Status: Pending approval`, [process.env.ADMIN_CHAT_ID, RESULTS_CHANNEL]);
      
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

    if (action === "save_wallet") {
      const walletAddress = String(body.walletAddress || "").trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        await client.query("ROLLBACK"); transactionStarted = false;
        return json(res, 400, { success: false, message: "Invalid wallet address." });
      }
      await client.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deposit_wallet TEXT`);
      await client.query(`UPDATE public.users SET deposit_wallet = $1 WHERE id = $2`, [walletAddress, user.id]);
      await client.query("COMMIT"); transactionStarted = false;
      return json(res, 200, { success: true, message: "Wallet address saved." });
    }

    if (action === "claim_rewards") {
      const autoCredited = await autoCreditReferralRewards(client, user.id);
      if (autoCredited > 0) {
        await client.query("COMMIT"); transactionStarted = false;
        return json(res, 200, { success: true, claimed_points: autoCredited.toFixed(2), auto: true });
      }

      const claimable = await client.query(`
        SELECT rr.id, rr.reward_points FROM public.referral_rewards rr
        JOIN public.users u ON u.id = rr.referred_user_id
        WHERE rr.referrer_user_id = $1 AND rr.status = 'pending'
        AND EXISTS (SELECT 1 FROM public.bets b WHERE b.user_id = u.id AND b.created_at > NOW() - INTERVAL '7 days')
        FOR UPDATE
      `, [user.id]);

      if (!claimable.rowCount) {
        await client.query("ROLLBACK"); transactionStarted = false;
        return json(res, 400, { success: false, message: "No active referral rewards available to claim." });
      }

      const amount = claimable.rows.reduce((sum, r) => sum + Number(r.reward_points), 0);
      const ids = claimable.rows.map(r => r.id);

      await client.query(`UPDATE public.referral_rewards SET status = 'credited', credited_at = NOW() WHERE id = ANY($1::bigint[])`, [ids]);
      await client.query(`UPDATE public.wallet_balances SET balance = balance + $1 WHERE user_id = $2`, [amount.toFixed(2), user.id]);
      
      await client.query("SAVEPOINT sp_claim_tx");
      try {
        await client.query(
          `INSERT INTO public.transactions (user_id, transaction_type, amount, status, created_at, updated_at)
           VALUES ($1, 'reward', $2, 'completed', NOW(), NOW())`,
          [user.id, amount.toFixed(2)]
        );
        await client.query("RELEASE SAVEPOINT sp_claim_tx");
      } catch(e) {
        await client.query("ROLLBACK TO SAVEPOINT sp_claim_tx");
      }

      await client.query("COMMIT"); transactionStarted = false;
      return json(res, 200, { success: true, claimed_points: amount.toFixed(2) });
    }

    if (action === "claim_commission") {
      const claimable = await client.query(`
        SELECT id, commission_amount FROM public.referral_commissions
        WHERE referrer_user_id = $1 AND claimed_at IS NULL
        FOR UPDATE
      `, [user.id]);

      if (!claimable.rowCount) {
        await client.query("ROLLBACK"); transactionStarted = false;
        return json(res, 400, { success: false, message: "No commission is available to claim." });
      }

      const amount = claimable.rows.reduce((sum, r) => sum + Number(r.commission_amount), 0);
      const ids = claimable.rows.map(r => r.id);

      await client.query(`UPDATE public.referral_commissions SET claimed_at = NOW() WHERE id = ANY($1::bigint[])`, [ids]);
      await client.query(`UPDATE public.wallet_balances SET balance = balance + $1 WHERE user_id = $2`, [amount.toFixed(2), user.id]);
      
      await client.query("SAVEPOINT sp_comm_tx");
      try {
        await client.query(
          `INSERT INTO public.transactions (user_id, transaction_type, amount, status, created_at, updated_at)
           VALUES ($1, 'commission', $2, 'completed', NOW(), NOW())`,
          [user.id, amount.toFixed(2)]
        );
        await client.query("RELEASE SAVEPOINT sp_comm_tx");
      } catch(e) {
        await client.query("ROLLBACK TO SAVEPOINT sp_comm_tx");
      }

      await client.query("COMMIT"); transactionStarted = false;
      return json(res, 200, { success: true, claimed_points: amount.toFixed(2) });
    }

    if (action === "place_bet") {
      const roundCode = String(body.round_code || "");
      const betType = String(body.bet_type || "");
      const requestId = String(body.request_id || "");
      const stakeText = String(body.stake ?? "").trim();
      const stake = Number(stakeText);
      const multiplier = Number(body.multiplier) || 1; 

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

      if (!ALLOWED_MULTIPLIERS.includes(multiplier)) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return json(res, 400, {
          success: false,
          message: "Invalid multiplier.",
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
      message: "Game request failed: " + error.message,
      detail: error.detail || error.message
    });
  } finally {
    if (client) client.release();
  }
};