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

    // 1. Lock rounds whose betting period has ended.
    await sql`
      UPDATE game_rounds
      SET status = 'locked'
      WHERE status = 'open'
        AND betting_closes_at <= ${now.toISOString()}
        AND ends_at > ${now.toISOString()}
    `;

    // 2. Settle expired rounds, up to 20 per cron execution.
    const settlements = [];

    for (let i = 0; i < 20; i++) {
      const rows = await sql`
        SELECT settle_expired_round() AS settlement
      `;

      const settlement = rows[0]?.settlement;

      if (
        !settlement ||
        settlement.message === "No expired unsettled round"
      ) {
        break;
      }

      if (settlement.success !== true) {
        throw new Error("Round settlement failed");
      }

      settlements.push(settlement);
    }

    // 3. Calculate the current UTC 3-minute round.
    const nowMs = Date.now();
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

    // 4. Create the current round if it does not exist.
    const initialStatus =
      nowMs < startMs + bettingMs ? "open" : "locked";

    await sql`
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
    `;

    // 5. Fetch the current round.
    const currentRounds = await sql`
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
      WHERE round_code = ${roundCode}
      LIMIT 1
    `;

    if (currentRounds.length === 0) {
      throw new Error("Current round could not be loaded");
    }

    return res.status(200).json({
      success: true,
      message: "Round schedule and settlement checked",
      server_time: now.toISOString(),
      settlements_processed: settlements.length,
      settlements,
      round: currentRounds[0]
    });

  } catch (error) {
    console.error("Cron error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to update rounds or settle expired rounds"
    });
  }
};