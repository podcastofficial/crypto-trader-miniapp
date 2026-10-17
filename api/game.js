const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

function verifyTelegramInitData(initData, botToken) {
  if (
    typeof initData !== "string" ||
    !initData ||
    initData.length > 10000
  ) {
    throw new Error("Please open the Mini App through Telegram.");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw new Error("Invalid Telegram authentication data.");
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
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
    throw new Error("Telegram authentication failed.");
  }

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isSafeInteger(authDate) ||
    authDate <= 0 ||
    authDate > now + 30 ||
    now - authDate > 3600
  ) {
    throw new Error("Session expired. Reopen the Mini App.");
  }

  let user;

  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    throw new Error("Invalid Telegram user information.");
  }

  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new Error("Telegram user information is missing.");
  }

  return user;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  const databaseUrl = process.env.DATABASE_URL;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!databaseUrl || !botToken) {
    return res.status(500).json({
      success: false,
      message: "Server configuration is missing."
    });
  }

  try {
    const sql = neon(databaseUrl);

    /*
     * GET:
     * Use PostgreSQL NOW() to identify the current round.
     * Do not depend on the serverless host's JavaScript clock
     * to decide whether a round is currently open for betting.
     */
    if (req.method === "GET") {
      const timeRows = await sql`
        SELECT NOW() AS server_time
      `;

      const serverTime = timeRows[0].server_time;

      const rows = await sql`
        SELECT
          id,
          round_code,
          status,
          starts_at,
          betting_closes_at,
          ends_at,
          result_number,
          settled_at
        FROM game_rounds
        ORDER BY starts_at DESC
        LIMIT 100
      `;

      const currentRows = await sql`
        SELECT
          id,
          round_code,
          status,
          starts_at,
          betting_closes_at,
          ends_at,
          result_number,
          settled_at
        FROM game_rounds
        WHERE status = 'open'
          AND starts_at <= NOW()
          AND betting_closes_at > NOW()
          AND ends_at > NOW()
        ORDER BY starts_at DESC
        LIMIT 1
      `;

      const currentRound = currentRows[0] || null;

      return res.status(200).json({
        success: true,
        server_time: new Date(serverTime).toISOString(),
        current_round: currentRound,
        rounds: rows
      });
    }

    /*
     * POST:
     * Authenticate the Telegram user.
     */
    const body = req.body || {};

    const telegramUser = verifyTelegramInitData(
      body.initData,
      botToken
    );

    const users = await sql`
      INSERT INTO users (telegram_id, username)
      VALUES (
        ${telegramUser.id},
        ${telegramUser.username || null}
      )
      ON CONFLICT (telegram_id)
      DO UPDATE SET username = EXCLUDED.username
      RETURNING id, telegram_id, username
    `;

    const user = users[0];

    if (!user) {
      throw new Error("Unable to resolve your account.");
    }

    /*
     * Ensure a wallet row exists.
     * Existing balances are not overwritten.
     */
    await sql`
      INSERT INTO wallet_balances (user_id, balance)
      VALUES (${user.id}, 0)
      ON CONFLICT (user_id) DO NOTHING
    `;

    /*
     * BALANCE
     */
    if (body.action === "balance") {
      const wallets = await sql`
        SELECT balance
        FROM wallet_balances
        WHERE user_id = ${user.id}
        LIMIT 1
      `;

      return res.status(200).json({
        success: true,
        balance: Number(wallets[0]?.balance ?? 0),
        user: {
          id: user.id,
          telegram_id: user.telegram_id,
          username: user.username
        }
      });
    }

    /*
     * MY BETS
     */
    if (body.action === "my_bets") {
      const bets = await sql`
        SELECT
          b.id,
          b.round_id,
          b.bet_type,
          b.selection,
          b.stake,
          b.fee,
          b.status,
          b.payout,
          b.created_at,
          b.settled_at,
          r.round_code,
          r.result_number
        FROM bets b
        LEFT JOIN game_rounds r
          ON r.id = b.round_id
        WHERE b.user_id = ${user.id}
        ORDER BY b.id DESC
        LIMIT 100
      `;

      return res.status(200).json({
        success: true,
        bets
      });
    }

    /*
     * PLACE BET
     *
     * The database function remains responsible for:
     * - Locking the wallet and round
     * - Checking the round's betting window
     * - Validating available balance
     * - Deducting the stake atomically
     * - Preventing duplicate requests
     */
    if (body.action === "place_bet") {
      const roundCode = body.round_code;
      const betType = body.bet_type;
      const requestId = body.request_id;
      const stakeInput = body.stake;

      if (
        typeof roundCode !== "string" ||
        !/^\d{12}$/.test(roundCode)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid round code."
        });
      }

      if (
        typeof requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          requestId
        )
      ) {
        return res.status(400).json({
          success: false,
          message: "A valid request ID is required."
        });
      }

      if (
        typeof stakeInput !== "number" &&
        typeof stakeInput !== "string"
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid stake."
        });
      }

      const stakeText = String(stakeInput);

      if (!/^\d{1,4}(\.\d{1,2})?$/.test(stakeText)) {
        return res.status(400).json({
          success: false,
          message: "Invalid stake amount."
        });
      }

      const stake = Number(stakeText);

      if (
        !Number.isFinite(stake) ||
        stake < 0.01 ||
        stake > 1000
      ) {
        return res.status(400).json({
          success: false,
          message: "Stake must be between 0.01 and 1000 test points."
        });
      }

      const allowedTypes = [
        "Number",
        "Red",
        "Green",
        "Violet",
        "Big",
        "Small"
      ];

      if (!allowedTypes.includes(betType)) {
        return res.status(400).json({
          success: false,
          message: "Invalid bet type."
        });
      }

      let selection = null;

      if (betType === "Number") {
        if (
          !Number.isInteger(body.selection) ||
          body.selection < 0 ||
          body.selection > 9
        ) {
          return res.status(400).json({
            success: false,
            message: "Select a number from 0 to 9."
          });
        }

        selection = body.selection;
      }

      const resultRows = await sql`
        SELECT place_bet_atomic(
          ${user.id}::bigint,
          ${roundCode}::text,
          ${betType}::text,
          ${selection}::smallint,
          ${stake}::numeric,
          ${requestId}::uuid
        ) AS result
      `;

      const result = resultRows[0]?.result;

      if (!result || result.success !== true) {
        return res.status(400).json({
          success: false,
          message: result?.message || "Bet could not be placed."
        });
      }

      return res.status(200).json(result);
    }

    return res.status(400).json({
      success: false,
      message: "Unknown action."
    });

  } catch (error) {
    const message = error.message || "Request failed.";

    if (
      message.includes("Telegram") ||
      message.includes("Session expired") ||
      message.includes("Mini App")
    ) {
      return res.status(401).json({
        success: false,
        message
      });
    }

    console.error("Game API error:", message);

    return res.status(500).json({
      success: false,
      message: "The server could not complete the request."
    });
  }
};