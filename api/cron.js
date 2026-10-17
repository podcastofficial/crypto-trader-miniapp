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

    // Use UTC 3-minute round boundaries.
    const now = new Date();
    const nowMs = now.getTime();
    const periodMs = 180000;
    const bettingMs = 150000;

    const startMs =
      Math.floor(nowMs / periodMs) * periodMs;

    const startsAt = new Date(startMs);
    const closesAt = new Date(startMs + bettingMs);
    const endsAt = new Date(startMs + periodMs);

    const roundCode = startsAt
      .toISOString()
      .replace(/[-:T.Z]/g, "")
      .slice(0, 12);

    // First, lock any expired open rounds.
    await sql`
      UPDATE game_rounds
      SET status = 'locked'
      WHERE status = 'open'
        AND betting_closes_at <= ${now.toISOString()}
    `;

    // Create the current round only if it does not already exist.
    const existing = await sql`
      SELECT id, round_code, status, starts_at,
             betting_closes_at, ends_at
      FROM game_rounds
      WHERE round_code = ${roundCode}
      LIMIT 1
    `;

    let round;

    if (existing.length > 0) {
      round = existing[0];
    } else {
      const initialStatus =
        nowMs < startMs + bettingMs ? "open" : "locked";

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
          ${initialStatus},
          ${startsAt.toISOString()},
          ${closesAt.toISOString()},
          ${endsAt.toISOString()}
        )
        ON CONFLICT (round_code)
        DO NOTHING
        RETURNING id, round_code, status, starts_at,
                  betting_closes_at, ends_at
      `;

      if (created.length > 0) {
        round = created[0];
      } else {
        const fetched = await sql`
          SELECT id, round_code, status, starts_at,
                 betting_closes_at, ends_at
          FROM game_rounds
          WHERE round_code = ${roundCode}
          LIMIT 1
        `;

        round = fetched[0];
      }
    }

    return res.status(200).json({
      success: true,
      message: "Round schedule checked",
      server_time: now.toISOString(),
      round
    });

  } catch (error) {
    console.error("Cron error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to update round schedule"
    });
  }
};