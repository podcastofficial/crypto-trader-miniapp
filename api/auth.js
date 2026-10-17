const crypto = require("crypto");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    return res.status(500).json({
      success: false,
      message: "Telegram authentication is not configured"
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
      .digest();

    const suppliedHash = Buffer.from(receivedHash, "hex");

    if (
      suppliedHash.length !== calculatedHash.length ||
      !crypto.timingSafeEqual(suppliedHash, calculatedHash)
    ) {
      return res.status(401).json({
        success: false,
        message: "Telegram signature verification failed"
      });
    }

    const authDate = Number(params.get("auth_date"));
    const currentTime = Math.floor(Date.now() / 1000);

    if (
      !Number.isFinite(authDate) ||
      authDate > currentTime + 30 ||
      currentTime - authDate > 3600
    ) {
      return res.status(401).json({
        success: false,
        message: "Telegram session expired. Reopen the app."
      });
    }

    let user;

    try {
      user = JSON.parse(params.get("user") || "null");
    } catch {
      user = null;
    }

    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
      return res.status(401).json({
        success: false,
        message: "Telegram user data is invalid"
      });
    }

    return res.status(200).json({
      success: true,
      user: {
        id: user.id,
        username: user.username || null,
        first_name: user.first_name || null
      }
    });
  } catch (error) {
    console.error("Auth API error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Authentication failed"
    });
  }
};