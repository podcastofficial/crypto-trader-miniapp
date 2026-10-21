const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 10000,
});

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

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
      initData.length === 0 ||
      initData.length > 10000
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid Telegram initData"
      });
    }

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (
      !receivedHash ||
      !/^[a-f0-9]{64}$/i.test(receivedHash)
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid Telegram signature"
      });
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
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

    // FIX: Increased from 3600 (1 hour) to 86400 (24 hours) to prevent sudden logouts
    if (
      !Number.isSafeInteger(authDate) ||
      authDate <= 0 ||
      authDate > now + 30 ||
      now - authDate > 86400 
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

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // FIX: Ensure columns exist
      await client.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS first_name TEXT`);
      await client.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_name TEXT`);
      await client.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS referral_code TEXT`);
      await client.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deposit_wallet TEXT`);

      // FIX: Added first_name and last_name to the insert query
      const users = await client.query(
        `INSERT INTO public.users (telegram_id, username, first_name, last_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (telegram_id)
         DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name
         RETURNING id, telegram_id, username, first_name, last_name, referral_code`,
        [String(user.id), user.username || null, user.first_name || null, user.last_name || null]
      );
      
      const registeredUser = users.rows[0];

      // FIX: Generate referral code if it doesn't exist
      if (!registeredUser.referral_code) {
        const code = crypto.randomBytes(8).toString("hex").toUpperCase();
        const codeResult = await client.query(
          `UPDATE public.users SET referral_code = $2 WHERE id = $1 RETURNING referral_code`,
          [registeredUser.id, code]
        );
        registeredUser.referral_code = codeResult.rows[0].referral_code;
      }

      await client.query(
        `INSERT INTO public.wallet_balances (user_id, balance)
         VALUES ($1, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [registeredUser.id]
      );

      await client.query("COMMIT");
      
      return res.status(200).json({
        success: true,
        message: "Telegram user verified",
        user: registeredUser
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error("Auth API error:", error.message);
    const safeMessage = error.code === "42P01"
      ? "Authentication database tables are not ready."
      : error.code === "23505"
        ? "Authentication conflict. Please retry."
        : "Authentication failed. Please reopen the Mini App.";
    return res.status(500).json({ success: false, message: safeMessage });
  }
};