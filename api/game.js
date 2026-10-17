const { neon } = require("@neondatabase/serverless");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
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
    const sql = neon(databaseUrl);

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
        message: "Game API is working",
        rounds
      });
    }

    return res.status(501).json({
      success: false,
      message: "Bet placement will be enabled after secure validation is implemented"
    });
  } catch (error) {
    console.error("Game API error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load game data"
    });
  }
};