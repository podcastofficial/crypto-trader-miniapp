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

function json(res, status, data) {
  return res.status(status).json(data);
}

function pageParams(input = {}) {
  const page = Math.max(
    1,
    parseInt(input.page || "1", 10) || 1
  );

  const pageSize = Math.min(
    10,
    Math.max(
      1,
      parseInt(input.page_size || "10", 10) || 10
    )
  );

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

function verifyTelegramInitData(initData) {
  try {
    if (
      !initData ||
      !process.env.TELEGRAM_BOT_TOKEN
    ) {
      return null;
    }

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");
    const authDate = Number(params.get("auth_date"));

    if (!receivedHash || !Number.isFinite(authDate)) {
      return null;
    }

    if (
      Math.abs(Date.now() / 1000 - authDate) > 3600
    ) {
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

    if (!user.id) {
      return null;
    }

    return user;
  } catch (error) {
    console.error("Telegram verification failed:", error.message);
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
    [
      String(telegramUser.id),
      telegramUser.username || null,
    ]
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

function validRequestId(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validRoundCode(value) {
  /*
   * Current round codes use 14 digits:
   * YYYYMMDDHHMMSS
   *
   * Example: 20261017120300
   */
  return typeof value === "string" &&
    /^\d{14}$/.test(value);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // ------------------------------------------
  // GET: Round history and current server round
  // ------------------------------------------
  if (req.method === "GET") {
    const { page, pageSize, offset } =
      pageParams(req.query || {});

    let client;

    try {
      client = await pool.connect();

      const serverTimeResult = await client.query(
        "SELECT NOW() AS server_time"
      );

      const totalResult = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM game_rounds`
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

      /*
       * Include an open round while it is accepting bets.
       * The frontend countdown uses betting_closes_at.
       */
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

      const total = Number(totalResult.rows[0].total);

      return json(res, 200, {
        success: true,
        server_time: serverTimeResult.rows[0].server_time,
        current_round: currentResult.rows[0] || null,
        rounds: roundsResult.rows,
        rounds_page: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.max(
            1,
            Math.ceil(total / pageSize)
          ),
          has_next: offset + pageSize < total,
          has_previous: page > 1,
        },
      });
    } catch (error) {
      console.error("GET /api/game error:", error);

      return json(res, 500, {
        success: false,
        message: "Unable to load game data.",
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  // ------------------------------------------
  // Only GET and POST are supported
  // ------------------------------------------
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return json(res, 405, {
      success: false,
      message: "Method not allowed.",
    });
  }

  // ------------------------------------------
  // Telegram authentication
  // ------------------------------------------
  const body = req.body || {};
  const telegramUser = verifyTelegramInitData(
    body.initData
  );

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
    const action = String(body.action || "");

    // ------------------------------------------
    // BALANCE
    // ------------------------------------------
    if (action === "balance") {
      const result = await client.query(
        `SELECT balance
         FROM wallet_balances
         WHERE user_id = $1`,
        [user.id]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return json(res, 200, {
        success: true,
        balance: result.rows[0]
          ? result.rows[0].balance
          : "0.00",
      });
    }

    // ------------------------------------------
    // BET HISTORY
    // ------------------------------------------
    if (action === "my_bets") {
      const { page, pageSize, offset } =
        pageParams(body);

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM bets
         WHERE user_id = $1`,
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
          total_pages: Math.max(
            1,
            Math.ceil(total / pageSize)
          ),
          has_next: offset + pageSize < total,
          has_previous: page > 1,
        },
      });
    }

    // ------------------------------------------
    // WALLET HISTORY
    // ------------------------------------------
    if (action === "wallet_history") {
      const { page, pageSize, offset } =
        pageParams(body);

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
          total_pages: Math.max(
            1,
            Math.ceil(total / pageSize)
          ),
          has_next: offset + pageSize < total,
          has_previous: page > 1,
        },
      });
    }

    // ------------------------------------------
    // PLACE BET
    // ------------------------------------------
    if (action === "place_bet") {
      const roundCode = String(body.round_code || "");
      const betType = String(body.bet_type || "");
      const requestId = String(body.request_id || "");
      const stake = Number(body.stake);

      const selection =
        body.selection === null ||
        body.selection === undefined
          ? null
          : Number(body.selection);

      /*
       * FIX:
       * Accept the 14-digit round code format
       * used by the current frontend/database.
       */
      if (!validRoundCode(roundCode)) {
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
        !Number.isFinite(stake) ||
        stake < 0.01 ||
        stake > 1000 ||
        Math.round(stake * 100) !== stake * 100
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return json(res, 400, {
          success: false,
          message: "Stake must be between 0.01 and 1000, maximum 2 decimals.",
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
        (
          betType === "Number" &&
          (
            !Number.isInteger(selection) ||
            selection < 0 ||
            selection > 9
          )
        ) ||
        (
          betType !== "Number" &&
          selection !== null
        )
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return json(res, 400, {
          success: false,
          message: "Invalid selection.",
        });
      }

      /*
       * The database function must independently verify:
       * - that the round exists;
       * - that betting is still open;
       * - that the user has enough balance;
       * - that the request ID has not already been used;
       * - that the stake deduction and bet insert are atomic.
       */
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

      const data = result.rows[0].result;

      const success =
        data &&
        (
          data.success === true ||
          data.success === "true"
        );

      if (!success) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return json(res, 400, {
          ...(data && typeof data === "object"
            ? data
            : {}),
          success: false,
          message:
            data?.message ||
            "Bet could not be placed.",
        });
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return json(res, 200, data);
    }

    // ------------------------------------------
    // UNKNOWN ACTION
    // ------------------------------------------
    await client.query("ROLLBACK");
    transactionStarted = false;

    return json(res, 400, {
      success: false,
      message: "Unknown action.",
    });

  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Transaction rollback error:",
          rollbackError.message
        );
      }
    }

    console.error("POST /api/game error:", error);

    return json(res, 500, {
      success: false,
      message: "Game request failed. Please try again.",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
};