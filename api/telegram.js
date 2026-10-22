const crypto = require("crypto");
const { Pool } = require("pg");

const APP_URL = "https://crypto-trader-miniapp.vercel.app";

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is missing");
    }

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    });
  }

  return pool;
}

// Creates the user (like the Mini App does) and applies the referral code.
async function applyReferralFromStart(from, code) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      `INSERT INTO public.users (telegram_id, username)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id)
       DO UPDATE SET username = EXCLUDED.username
       RETURNING id`,
      [String(from.id), from.username || null]
    );

    const userId = userResult.rows[0].id;

    await client.query(
      `INSERT INTO public.wallet_balances (user_id, balance)
       VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    const result = await client.query(
      `SELECT public.apply_referral_code($1::bigint, $2::text) AS result`,
      [userId, code]
    );

    const data = result.rows[0] && result.rows[0].result;

    // The user row is kept even if the referral is rejected.
    await client.query("COMMIT");

    if (data && data.success === true) {
      return { applied: true };
    }

    return {
      applied: false,
      message: (data && data.message) || "Referral could not be applied."
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!botToken || !webhookSecret) {
    console.error("Telegram webhook environment variables missing");

    return res.status(500).json({
      success: false,
      message: "Server configuration missing"
    });
  }

  const suppliedSecret = req.headers["x-telegram-bot-api-secret-token"];

  if (
    typeof suppliedSecret !== "string" ||
    suppliedSecret.length !== webhookSecret.length ||
    !crypto.timingSafeEqual(
      Buffer.from(suppliedSecret),
      Buffer.from(webhookSecret)
    )
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized webhook"
    });
  }

  try {
    const update = req.body || {};
    const message = update.message;

    // Ignore updates that are not private messages.
    if (
      !message ||
      !message.chat ||
      !message.from ||
      message.from.is_bot ||
      message.chat.type !== "private"
    ) {
      return res.status(200).json({ success: true });
    }

    const chatId = message.chat.id;
    const text = typeof message.text === "string"
      ? message.text.trim()
      : "";

    if (!text.startsWith("/start")) {
      return res.status(200).json({ success: true });
    }

    const parts = text.split(/\s+/);
    const startParameter = parts[1] || "";
    const referralMatch = startParameter.match(
      /^ref_([A-Za-z0-9_-]{1,64})$/
    );

    // ==========================================
    // 🔥 PREMIUM WELCOME MESSAGE (PURE ENGLISH)
    // ==========================================
    let welcomeText =
      "🚀 <b>Welcome to Crypto Trader Pro!</b> 🚀\n\n" +
      "🎮 <b>About the Game</b>\n" +
      "A fast-paced crypto prediction game! Predict crypto price movements and win big rewards.\n\n" +
      "✨ <b>Features:</b>\n" +
      "⚡ Instant Payouts\n" +
      "🎯 Fair & Transparent Results\n" +
      "🎁 Exclusive Gift Codes\n" +
      "🤝 Refer & Earn Commissions\n\n" +
      "👇 <b>Tap the button below to start playing!</b>";

    if (referralMatch) {
      try {
        const outcome = await applyReferralFromStart(
          message.from,
          referralMatch[1]
        );

        welcomeText += outcome.applied
          ? "\n\n🎁 <b>Referral applied successfully!</b>"
          : "\n\nℹ️ <i>" + outcome.message + "</i>";
      } catch (error) {
        console.error("Referral apply error:", error.message);

        welcomeText +=
          "\n\n⚠️ <i>Referral could not be processed right now. " +
          "Open the Mini App and enter the code in the Referral tab.</i>";
      }
    }

    // 🚨 DIRECT IMAGE LINK
    const bannerImageUrl = "https://raw.githubusercontent.com/podcastofficial/crypto-trader-miniapp/main/1792659429580.png"; 

    // Telegram API Call
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendPhoto`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          photo: bannerImageUrl, 
          caption: welcomeText,  
          parse_mode: "HTML", 
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🚀 Play Now",
                  web_app: { url: APP_URL }
                }
              ]
            ]
          }
        })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      console.error(
        "Telegram sendPhoto failed:",
        result.description || response.status
      );

      return res.status(502).json({
        success: false,
        message: "Telegram message delivery failed"
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Telegram webhook error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Webhook processing failed"
    });
  }
};