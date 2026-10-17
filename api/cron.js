const { neon } = require("@neondatabase/serverless");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const secret = process.env.CRON_SECRET;
  const databaseUrl = process.env.DATABASE_URL;

  if (!secret || !databaseUrl) {
    return res.status(500).json({
      success: false,
      message: "Server configuration missing"
    });
  }

  if (req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  try {
    const sql = neon(databaseUrl);
    const now = new Date();

    // Align round start to a UTC 3-minute boundary.
    const startMs =
      Math.floor(now.getTime() / 180000) * 180000;

    const startsAt = new Date(startMs);
    const closesAt = new Date(startMs + 150000);
    const endsAt = new Date(startMs + 180000);

    const roundCode = startsAt
      .toISOString()
      .replace(/[-:T.Z]/g, "")
      .slice(0, 12);

    const rows = await sql`
      INSERT INTO game_rounds (
        round_code,
        status,
        starts_at,
        betting_closes_at,
        ends_at
      )
      VALUES (
        ${roundCode},
        ${now.getTime() < startMs + 150000 ? "open" : "locked"},
        ${startsAt.toISOString()},
        ${closesAt.toISOString()},
        ${endsAt.toISOString()}
      )
      ON CONFLICT (round_code)
      DO UPDATE SET round_code = EXCLUDED.round_code
      RETURNING
        id,
        round_code,
        status,
        starts_at,
        betting_closes_at,
        ends_at
    `;

    return res.status(200).json({
      success: true,
      message: "Round created or already exists",
      round: rows[0]
    });
  } catch (error) {
    console.error("Cron error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to create round"
    });
  }
};