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

  if (
    !user ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0
  ) {
    throw new Error("Telegram user information is missing.");
  }

  return user;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

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

    // Public round-list endpoint. It exposes no private user data.
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

    // Resolve the authenticated Telegram identity on the server.
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

    // Create a wallet row if one does not already exist.
    await sql`
      INSERT INTO wallet_balances (user_id, balance)
      VALUES (${user.id}, 0)
      ON CONFLICT (user_id) DO NOTHING
    `;

    const action = body.action;

    if (action === "balance") {
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

    if (action === "my_bets") {
      const bets = await sql`
        SELECT
          id,
          round_id,
          bet_type,
          selection,
          stake,
          fee,
          status,
          payout,
          created_at,
          settled_at
        FROM bets
        WHERE user_id = ${user.id}
        ORDER BY id DESC
        LIMIT 100
      `;

      return res.status(200).json({
        success: true,
        bets
      });
    }

    if (action === "place_bet") {
      return res.status(501).json({
        success: false,
        message:
          "Bet placement is temporarily disabled until atomic balance deduction and settlement safeguards are implemented."
      });
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