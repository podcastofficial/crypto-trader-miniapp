const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const BET_TYPES = ["Number", "Red", "Green", "Violet", "Big", "Small"];

function json(res, status, data) {
  return res.status(status).json(data);
}

function pageParams(body = {}) {
  const page = Math.max(1, parseInt(body.page || "1", 10) || 1);
  const pageSize = Math.min(
    10,
    Math.max(1, parseInt(body.page_size || "10", 10) || 10)
  );

  return { page, pageSize, offset: (page - 1) * pageSize };
}

function verifyTelegramInitData(initData) {
  try {
    if (!initData || !process.env.TELEGRAM_BOT_TOKEN) return null;

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");
    const authDate = Number(params.get("auth_date"));

    if (!receivedHash || !authDate) return null;

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

    const received = Buffer.from(receivedHash, "hex");
    const calculated = Buffer.from(calculatedHash, "hex");

    if (
      received.length !== calculated.length ||
      !crypto.timingSafeEqual(received, calculated)
    ) {
      return null;
    }

    const user = JSON.parse(params.get("user") || "{}");

    if (!user.id) return null;

    return user;
  } catch {
    return null;
  }
}

async function getUser(client, telegramUser) {
  const result = await client.query(
    `INSERT INTO users (telegram_id, username)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id)
     DO UPDATE SET username = EXCLUDED.username
     RETURNING id, telegram_id, username`,
    [String(telegramUser.id), telegramUser.username || null]
  );

  const user = result.rows[0];

  await client.query(
    `INSERT INTO wallet_balances (user_id, balance)
     VALUES ($1, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id]
  );

  return user;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    const { page, pageSize, offset } = pageParams(req.query || {});
    const client = await pool.connect();

    try {
      const serverTime = await client.query(
        "SELECT NOW() AS server_time"
      );

      const totalResult = await client.query(
        "SELECT COUNT(*)::int AS total FROM game_rounds"
      );

      const roundsResult = await client.query(
        `SELECT id, round_code, status, starts_at,
                betting_closes_at, ends_at,
                result_number, created_at, settled_at
         FROM game_rounds
         ORDER BY starts_at DESC
         LIMIT $1 OFFSET $2`,
        [pageSize, offset]
      );

      const currentResult = await client.query(
        `SELECT id, round_code, status, starts_at,
                betting_closes_at, ends_at
         FROM game_rounds
         WHERE status = 'open'
           AND starts_at <= NOW()
           AND betting_closes_at > NOW()
           AND ends_at > NOW()
         ORDER BY starts_at DESC
         LIMIT 1`
      );

      const total = totalResult.rows[0].total;

      return json(res, 200, {
        success: true,
        server_time: serverTime.rows[0].server_time,
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
      client.release();
    }
  }

  if (req.method !== "POST") {
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

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const user = await getUser(client, telegramUser);
    const action = String(body.action || "");

    if (action === "balance") {
      const result = await client.query(
        `SELECT balance
         FROM wallet_balances
         WHERE user_id = $1`,
        [user.id]
      );

      await client.query("COMMIT");

      return json(res, 200, {
        success: true,
        balance: result.rows[0]?.balance || "0.00",
      });
    }

    if (action === "my_bets") {
      const { page, pageSize, offset } = pageParams(body);

      const countResult = await client.query(
        "SELECT COUNT(*)::int AS total FROM bets WHERE user_id = $1",
        [user.id]
      );

      const result = await client.query(
        `SELECT b.id, b.bet_type, b.selection, b.stake,
                b.fee, b.status, b.payout, b.created_at,
                b.settled_at, r.round_code, r.result_number
         FROM bets b
         JOIN game_rounds r ON r.id = b.round_id
         WHERE b.user_id = $1
         ORDER BY b.id DESC
         LIMIT $2 OFFSET $3`,
        [user.id, pageSize, offset]
      );

      const total = countResult.rows[0].total;

      await client.query("COMMIT");

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

    if (action === "wallet_history") {
      const { page, pageSize, offset } = pageParams(body);

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM transactions
         WHERE user_id = $1`,
        [user.id]
      );

      const result = await client.query(
        `SELECT id, transaction_type, amount, status,
                network, tx_hash, created_at, updated_at
         FROM transactions
         WHERE user_id = $1
         ORDER BY id DESC
         LIMIT $2 OFFSET $3`,
        [user.id, pageSize, offset]
      );

      const total = countResult.rows[0].total;

      await client.query("COMMIT");

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

    if (action === "place_bet") {
      const roundCode = String(body.round_code || "");
      const betType = String(body.bet_type || "");
      const requestId = String(body.request_id || "");
      const stake = Number(body.stake);

      const selection =
        body.selection === null || body.selection === undefined
          ? null
          : Number(body.selection);

      if (!/^\d{12}$/.test(roundCode)) {
        await client.query("ROLLBACK");
        return json(res, 400, {
          success: false,
          message: "Invalid round code.",
        });
      }

      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          requestId
        )
      ) {
        await client.query("ROLLBACK");
        return json(res, 400, {
          success: false,
          message: "Invalid request ID. Please retry.",
        });
      }

      if (
        !Number.isFinite(stake) ||
        stake < 0.01 ||
        stake > 1000 ||
        Math.round(stake * 100) !== stake * 100
      ) {
        await client.query("ROLLBACK");
        return json(res, 400, {
          success: false,
          message: "Stake must be between 0.01 and 1000, maximum 2 decimals.",
        });
      }

      if (!BET_TYPES.includes(betType)) {
        await client.query("ROLLBACK");
        return json(res, 400, {
          success: false,
          message: "Invalid bet type.",
        });
      }

      if (
        (betType === "Number" &&
          (!Number.isInteger(selection) || selection < 0 || selection > 9)) ||
        (betType !== "Number" && selection !== null)
      ) {
        await client.query("ROLLBACK");
        return json(res, 400, {
          success: false,
          message: "Invalid selection.",
        });
      }

      const result = await client.query(
        `SELECT place_bet_atomic(
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

      await client.query("COMMIT");

      const data = result.rows[0].result;
      const success =
        data?.success === true ||
        data?.success === "true";

      return json(res, success ? 200 : 400, data);
    }

    await client.query("ROLLBACK");

    return json(res, 400, {
      success: false,
      message: "Unknown action.",
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("POST /api/game:", error);

    return json(res, 500, {
      success: false,
      message: "Game request failed. Please try again.",
    });
  } finally {
    client.release();
  }
};