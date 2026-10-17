const APP_URL = "https://crypto-trader-miniapp.vercel.app";

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

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

  const receivedSecret =
    req.headers["x-telegram-bot-api-secret-token"];

  if (
    typeof receivedSecret !== "string" ||
    receivedSecret !== webhookSecret
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized webhook"
    });
  }

  try {
    const update = req.body || {};
    const message = update.message;

    // Ignore updates that are not regular messages.
    if (!message || !message.chat || !message.text) {
      return res.status(200).json({
        success: true,
        message: "Update ignored"
      });
    }

    const text = message.text.trim();

    // Process /start and /start ref_CODE.
    const match = text.match(
      /^\/start(?:@\w+)?(?:\s+(\S+))?/i
    );

    if (!match) {
      return res.status(200).json({
        success: true,
        message: "Command ignored"
      });
    }

    const startParameter = match[1] || "";
    let referralCode = "";

    if (startParameter) {
      const referralMatch = startParameter.match(
        /^ref_([A-Za-z0-9_-]{1,80})$/i
      );

      if (referralMatch) {
        referralCode = referralMatch[1];
      }
    }

    // Forward the referral code to the Mini App URL.
    const appUrl = new URL(APP_URL);

    if (referralCode) {
      appUrl.searchParams.set("ref", referralCode);
    }

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: "🚀 Open Crypto Trader Pro",
            web_app: {
              url: appUrl.toString()
            }
          }
        ]
      ]
    };

    let welcomeMessage =
      "Welcome to Crypto Trader Pro! 🚀\n\n" +
      "Open the Mini App using the button below.";

    if (referralCode) {
      welcomeMessage +=
        "\n\nReferral code detected. It will be processed " +
        "when you open the Mini App.";
    }

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: message.chat.id,
          text: welcomeMessage,
          reply_markup: keyboard
        })
      }
    );

    let telegramData;

    try {
      telegramData = await telegramResponse.json();
    } catch {
      telegramData = null;
    }

    if (!telegramResponse.ok || !telegramData?.ok) {
      console.error(
        "Telegram sendMessage failed:",
        telegramData?.description || telegramResponse.status
      );

      return res.status(502).json({
        success: false,
        message: "Unable to send Telegram response"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Start command processed",
      referral_detected: Boolean(referralCode)
    });
  } catch (error) {
    console.error("Telegram webhook error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Webhook processing failed"
    });
  }
};