const { neon } = require("@neondatabase/serverless");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      message: "Use POST method"
    });
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return res.status(500).json({
      success: false,
      message: "Database configuration is missing"
    });
  }

  try {
    const {
      user_id,
      round_id,
      bet_type,
      selection,
      stake
    } = req.body || {};

    const userId = Number(user_id);
    const roundId = Number(round_id);
    const amount = Number(stake);
    const choice = Number(selection);

    const allowedTypes = [
      "Red",
      "Green",
      "Violet",
      "Number",
      "Big",
      "Small"
    ];

    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      !Number.isSafeInteger(roundId) ||
      roundId <= 0 ||
      !allowedTypes.includes(bet_type) ||
      !Number.isInteger(choice) ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > 100000
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid bet details"
      });
    }

    if (
      (bet_type === "Number" && (choice < 0 || choice > 9)) ||
      (bet_type === "Red" && choice !== 0) ||
      (bet_type === "Green" && choice !== 0) ||
      (bet_type === "Violet" && choice !== 0) ||
      (bet_type === "Big" && choice !== 0) ||
      (bet_type === "Small" && choice !== 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid selection"
      });
    }

    const sql = neon(databaseUrl);

    const rounds = await sql`
      SELECT id
      FROM game_rounds
      WHERE id = ${roundId}
        AND status = 'open'
        AND NOW() < betting_closes_at
      LIMIT 1
    `;

    if (rounds.length === 0) {
      return res.status(409).json({
        success: false,
        message: "Betting is closed for this round"
      });
    }

    return res.status(501).json({
      success: false,
      message: "Bet placement is not enabled yet. Secure wallet transactions must be implemented first."
    });
  } catch (error) {
    console.error("Bet API error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to validate bet"
    });
  }
};