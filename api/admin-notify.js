module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.ADMIN_CHAT_ID;
  const notifySecret = process.env.ADMIN_NOTIFY_SECRET;

  if (!botToken || !adminChatId || !notifySecret) {
    return res.status(500).json({
      success: false,
      message: "Server configuration is incomplete"
    });
  }

  const providedSecret = req.headers["x-admin-secret"];

  if (typeof providedSecret !== "string" || providedSecret !== notifySecret) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  const message =
    "🧪 Crypto Trader Pro\\n\\n" +
    "✅ Admin notification test successful.\\n" +
    "🔔 Telegram connection is working.";

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: adminChatId,
          text: message
        })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      console.error("Telegram notification failed");
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