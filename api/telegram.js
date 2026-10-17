const crypto = require("crypto");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const appUrl = "https://crypto-trader-miniapp.vercel.app";

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

    // Ignore updates that are not messages.
    if (!message || !message.chat || !message.from) {
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

    let welcomeText =
      "🎮 Welcome to Crypto Trader Pro!\n\n" +
      "Open the Mini App to explore the game, wallet, records and referral program.\n\n" +
      "Educational entertainment only. No guaranteed earnings.";

    if (referralMatch) {
      welcomeText +=
        "\n\n🎁 Referral link detected. Open the Mini App to continue.";
    }

    const telegramApi =
      `https://api.telegram.org/bot${botToken}/sendMessage`;

    const payload = {
      chat_id: chatId,
      text: welcomeText,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🚀 Open Crypto Trader Pro",
              web_app: {
                url: appUrl
              }
            }
          ]
        ]
      }
    };

    const response = await fetch(telegramApi, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
      console.error(
        "Telegram sendMessage failed:",
        result.description || response.status
      );

      return res.status(502).json({
        success: false,
        message: "Telegram message delivery failed"
      });
    }

    return res.status(200).json({
      success: true
    });
  } catch (error) {
    console.error("Telegram webhook error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Webhook processing failed"
    });
  }
};