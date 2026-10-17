const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  // Allow POST requests only
  if (req.method !== "POST") {
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
    const { initData } = req.body || {};

    if (
      typeof initData !== "string" ||
      !initData ||
      initData.length > 10000
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid Telegram initData"
      });
    }

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
      return res.status(401).json({
        success: false,
        message: "Invalid Telegram signature"
      });
    }

    // Remove hash before calculating Telegram's signature
    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    // Telegram Mini App official HMAC validation
    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const receivedBuffer = Buffer.from(receivedHash, "hex");
    const calculatedBuffer = Buffer.from(calculatedHash, "hex");

    if (
      receivedBuffer.length !== calculatedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, calculatedBuffer)
    ) {
      return res.status(401).json({
        success: false,
        message: "Telegram verification failed"
      });
    }

    const authDate = Number(params.get("auth_date"));
    const now = Math.floor(Date.now() / 1000);

    if (
      !Number.isSafeInteger(authDate) ||
      authDate <= 0 ||
      authDate > now + 30 ||
      now - authDate > 3600
    ) {
      return res.status(401).json({
        success: false,
        message: "Session expired. Reopen Telegram Mini App."
      });
    }

    const userString = params.get("user");

    if (!userString) {
      return res.status(401).json({
        success: false,
        message: "Telegram user data missing"
      });
    }

    let user;

    try {
      user = JSON.parse(userString);
    } catch {
      return res.status(400).json({
        success: false,
        message: "Invalid Telegram user data"
      });
    }

    if (
      !user ||
      !Number.isSafeInteger(user.id) ||
      user.id <= 0
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid Telegram user"
      });
    }

    const sql = neon(databaseUrl);

    const users = await sql`
      INSERT INTO users (telegram_id, username)
      VALUES (
        ${user.id},
        ${user.username || null}
      )
      ON CONFLICT (telegram_id)
      DO UPDATE SET username = EXCLUDED.username
      RETURNING id, telegram_id, username
    `;

    return res.status(200).json({
      success: true,
      message: "Telegram user verified",
      user: users[0]
    });
  } catch (error) {
    console.error("Auth API error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Authentication failed"
    });
  }
};