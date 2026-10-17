const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

function verifyTelegramInitData(initData, botToken) {
  if (
    typeof initData !== "string" ||
    !initData.length ||
    initData.length > 10000
  ) {
    throw new Error("INVALID_INIT_DATA");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw new Error("INVALID_SIGNATURE");
  }

  params.delete("hash");

  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  const received = Buffer.from(receivedHash, "hex");
  const calculated = Buffer.from(calculatedHash, "hex");

  if (
    received.length !== calculated.length ||
    !crypto.timingSafeEqual(received, calculated)
  ) {
    throw new Error("INVALID_SIGNATURE");
  }

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isSafeInteger(authDate) ||
    authDate <= 0 ||
    authDate > now + 30 ||
    now - authDate > 3600
  ) {
    throw new Error("SESSION_EXPIRED");
  }

  let user;

  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    throw new Error("INVALID_USER");
  }

  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new Error("INVALID_USER");
  }

  return user;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const databaseUrl = process.env.DATABASE_URL;

  if (!botToken || !databaseUrl) {
    return res.status(500).json({
      success: false,
      message: "Server configuration missing"
    });
  }

  try {
    const sql = neon(databaseUrl);

    if (req.method === "GET") {
      const rounds = await sql`
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
        ORDER BY id DESC
        LIMIT 10
      `;

      return res.status(200).json({
        success: true,
        rounds
      });
    }

    const body = req.body || {};
    const telegramUser = verifyTelegramInitData(
      body.initData,
      botToken
    );

    const users = await sql`
      SELECT id
      FROM users
      WHERE telegram_id = ${telegramUser.id}
      LIMIT 1
    `;

    if (!users.length) {
      return res.status(401).json({
        success: false,
        message: "Open the Mini App again to authenticate."
      });
    }

    const userId = users[0].id;
    const action = body.action;

    if (action === "balance") {
      const balances = await sql`
        SELECT balance
        FROM wallet_balances
        WHERE user_id = ${userId}
        LIMIT 1
      `;

      return res.status(200).json({
        success: true,
        balance: balances.length
          ? String(balances[0].balance)
          : "0"
      });
    }

    if (action === "my_bets") {
      const bets = await sql`
        SELECT
          b.id,
          b.round_id,
          b.bet_type,
          b.selection,
          b.stake,
          b.status,
          b.payout,
          b.created_at,
          g.round_code,
          g.result_number
        FROM bets b
        JOIN game_rounds g ON g.id = b.round_id
        WHERE b.user_id = ${userId}
        ORDER BY b.id DESC
        LIMIT 50
      `;

      return res.status(200).json({
        success: true,
        bets
      });
    }

    if (action !== "place_bet") {
      return res.status(400).json({
        success: false,
        message: "Unknown action"
      });
    }

    const roundId = Number(body.roundId);
    const stake = Number(body.stake);
    const betType = body.betType;
    const selection = body.selection;

    if (
      !Number.isSafeInteger(roundId) ||
      roundId <= 0 ||
      !Number.isFinite(stake) ||
      stake <= 0 ||
      stake > 1000000 ||
      Math.round(stake * 100) !== stake * 100
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid round or stake"
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
        message: "Invalid bet type"
      });
    }

    let chosenNumber = null;

    if (betType === "Number") {
      if (
        !Number.isInteger(selection) ||
        selection < 0 ||
        selection > 9
      ) {
        return res.status(400).json({
          success: false,
          message: "Select a number between 0 and 9"
        });
      }

      chosenNumber = selection;
    } else if (selection !== undefined && selection !== null) {
      return res.status(400).json({
        success: false,
        message: "Selection must be omitted for this bet type"
      });
    }

    /*
     * One SQL statement:
     * - checks the round is open and betting has not closed
     * - deducts the wallet balance
     * - inserts the bet and ledger transaction
     *
     * All changes roll back together if a later CTE fails.
     */
    const placed = await sql`
      WITH valid_round AS MATERIALIZED (
        SELECT id
        FROM game_rounds
        WHERE id = ${roundId}
          AND status = 'open'
          AND NOW() >= starts_at
          AND NOW() < betting_closes_at
          AND NOW() < ends_at
      ),
      deducted AS (
        UPDATE wallet_balances
        SET
          balance = balance - ${stake},
          updated_at = NOW()
        WHERE user_id = ${userId}
          AND balance >= ${stake}
          AND EXISTS (SELECT 1 FROM valid_round)
        RETURNING user_id
      ),
      new_bet AS (
        INSERT INTO bets (
          user_id,
          round_id,
          bet_type,
          selection,
          stake,
          fee,
          status,
          payout
        )
        SELECT
          ${userId},
          valid_round.id,
          ${betType},
          ${chosenNumber},
          ${stake},
          0,
          'pending',
          0
        FROM valid_round
        JOIN deducted ON TRUE
        RETURNING id, round_id, stake, bet_type, selection, status
      ),
      ledger AS (
        INSERT INTO transactions (
          user_id,
          transaction_type,
          amount,
          status
        )
        SELECT
          ${userId},
          'bet',
          ${stake},
          'completed'
        FROM new_bet
        RETURNING id
      )
      SELECT
        new_bet.id,
        new_bet.round_id,
        new_bet.stake,
        new_bet.bet_type,
        new_bet.selection,
        new_bet.status
      FROM new_bet
      CROSS JOIN ledger
    `;

    if (!placed.length) {
      return res.status(409).json({
        success: false,
        message:
          "Bet rejected. Check your balance and confirm the round is still open."
      });
    }

    const balances = await sql`
      SELECT balance
      FROM wallet_balances
      WHERE user_id = ${userId}
      LIMIT 1
    `;

    return res.status(201).json({
      success: true,
      message: "Bet placed successfully",
      bet: placed[0],
      balance: balances.length
        ? String(balances[0].balance)
        : null
    });

  } catch (error) {
    console.error("Game API error:", error.message);

    const messages = {
      INVALID_INIT_DATA: "Invalid Telegram authentication data",
      INVALID_SIGNATURE: "Telegram verification failed",
      SESSION_EXPIRED: "Session expired. Reopen the Mini App.",
      INVALID_USER: "Invalid Telegram user"
    };

    const authErrors = [
      "INVALID_INIT_DATA",
      "INVALID_SIGNATURE",
      "SESSION_EXPIRED",
      "INVALID_USER"
    ];

    if (authErrors.includes(error.message)) {
      return res.status(401).json({
        success: false,
        message: messages[error.message]
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to process game request"
    });
  }
};