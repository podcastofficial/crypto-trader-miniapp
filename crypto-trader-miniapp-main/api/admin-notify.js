module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // Allow POST requests only
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  // Read server-side environment variables
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.ADMIN_CHAT_ID;
  const notifySecret = process.env.ADMIN_NOTIFY_SECRET;

  // Check server configuration
  if (!botToken || !adminChatId || !notifySecret) {
    return res.status(500).json({
      success: false,
      message: "Server configuration is incomplete",
      missing: {
        botToken: !botToken,
        adminChatId: !adminChatId,
        notifySecret: !notifySecret
      }
    });
  }

  // Read secret from request header
  const providedSecret = req.headers["x-admin-secret"];

  if (typeof providedSecret !== "string" || !providedSecret) {
    return res.status(401).json({
      success: false,
      message: "Secret header is missing"
    });
  }

  // Compare secrets without returning either secret to the client
  if (providedSecret.trim() !== notifySecret.trim()) {
    return res.status(401).json({
      success: false,
      message: "Secret does not match"
    });
  }

  // Fixed test message only. Do not accept arbitrary messages from clients.
  const message = [
    "🧪 Crypto Trader Pro",
    "",
    "✅ Admin notification test successful.",
    "🔔 Telegram connection is working."
  ].join("\n");

  try {
    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: adminChatId,
          text: message
        }),
        signal: AbortSignal.timeout(10000)
      }
    );

    const telegramResult = await telegramResponse.json();

    if (!telegramResponse.ok || !telegramResult.ok) {
      // Do not expose bot tokens or raw Telegram error details.
      console.error(
        "Telegram notification failed with HTTP status:",
        telegramResponse.status
      );

      return res.status(502).json({
        success: false,
        message: "Telegram notification failed"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Admin notification sent"
    });

  } catch (error) {
    console.error("Telegram request failed");

    return res.status(502).json({
      success: false,
      message: "Unable to contact Telegram"
    });
  }
};