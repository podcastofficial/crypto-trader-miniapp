const { neon } = require("@neondatabase/serverless");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
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

    const now = new Date();
    const minute = Math.floor(now.getUTCMinutes() / 3) * 3;

    const startsAt = new Date(now);
    startsAt.setUTCMinutes(minute, 0, 0);

    const closesAt = new Date(startsAt.getTime() + 120000);
    const endsAt = new Date(startsAt.getTime() + 180000);

    const roundCode =
      startsAt.toISOString().replace(/[-:T.Z]/g, "").slice(0, 12);

    const existing = await sql`
      SELECT id, round_code, status
      FROM game_rounds
      WHERE round_code = ${roundCode}
      LIMIT 1
    `;

    if (existing.length > 0) {
      return res.status(200).json({
        success: true,
        message: "Round already exists",
        round: existing[0]
      });
    }

    const created = await sql`
      INSERT INTO game_rounds (
        round_code,
        status,
        starts_at,
        betting_closes_at,
        ends_at
      )
      VALUES (
        ${roundCode},
        'open',
        ${startsAt.toISOString()},
        ${closesAt.toISOString()},
        ${endsAt.toISOString()}
      )
      RETURNING id, round_code, status, starts_at,
                betting_closes_at, ends_at
    `;

    return res.status(200).json({
      success: true,
      message: "Round created successfully",
      round: created[0]
    });
  } catch (error) {
    console.error("Cron error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to create game round"
    });
  }
};