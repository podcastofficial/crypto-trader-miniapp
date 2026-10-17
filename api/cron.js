const { neon } = require("@neondatabase/serverless");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  const cronSecret = process.env.CRON_SECRET;

  if (
    !cronSecret ||
    req.headers.authorization !== `Bearer ${cronSecret}`
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const now = new Date();

    const startMinute = Math.floor(now.getUTCMinutes() / 3) * 3;
    const startsAt = new Date(now);

    startsAt.setUTCMinutes(startMinute, 0, 0);

    const closesAt = new Date(startsAt.getTime() + 120000);
    const endsAt = new Date(startsAt.getTime() + 180000);

    const roundCode = startsAt
      .toISOString()
      .replace(/[-:T.Z]/g, "")
      .slice(0, 12);

    const rounds = await sql`
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
      ON CONFLICT (round_code) DO UPDATE
      SET round_code = EXCLUDED.round_code
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
      message: "Cron executed successfully",
      round: rounds[0]
    });
  } catch (error) {
    console.error("Cron error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to create game round"
    });
  }
};