const { neon } = require("@neondatabase/serverless");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const cronSecret = process.env.CRON_SECRET;
  const databaseUrl = process.env.DATABASE_URL;

  if (!cronSecret || !databaseUrl) {
    console.error("Missing CRON_SECRET or DATABASE_URL");

    return res.status(500).json({
      success: false,
      message: "Server configuration missing"
    });
  }

  const authorization = req.headers.authorization || "";

  if (authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  try {
    const sql = neon(databaseUrl);

    const timeRows = await sql`
      SELECT NOW() AS server_time
    `;

    const serverTime = new Date(timeRows[0].server_time);
    const nowMs = serverTime.getTime();

    const ROUND_MS = 180000;
    const BETTING_MS = 150000;
    const currentStartMs =
      Math.floor(nowMs / ROUND_MS) * ROUND_MS;

    /*
     * 1. Lock betting when the 150-second window ends.
     */
    const lockedRows = await sql`
      UPDATE game_rounds
      SET status = 'locked'
      WHERE status = 'open'
        AND betting_closes_at <= NOW()
        AND ends_at > NOW()
      RETURNING round_code
    `;

    /*
     * 2. Create the current round if it does not exist.
     *
     * Period code uses the UTC round-start timestamp.
     * Existing rounds are never overwritten.
     */
    const roundStart = new Date(currentStartMs);
    const roundClose = new Date(currentStartMs + BETTING_MS);
    const roundEnd = new Date(currentStartMs + ROUND_MS);

    const roundCode = roundStart
      .toISOString()
      .replace(/[-:T.Z]/g, "")
      .slice(0, 12);

    let currentStatus = "open";

    if (nowMs >= currentStartMs + BETTING_MS) {
      currentStatus = "locked";
    }

    const createdRows = await sql`
      INSERT INTO game_rounds (
        round_code,
        status,
        starts_at,
        betting_closes_at,
        ends_at
      )
      VALUES (
        ${roundCode},
        ${currentStatus},
        ${roundStart.toISOString()},
        ${roundClose.toISOString()},
        ${roundEnd.toISOString()}
      )
      ON CONFLICT (round_code) DO NOTHING
      RETURNING round_code
    `;

    /*
     * 3. Settle expired rounds.
     *
     * The existing database function must perform the
     * settlement transaction safely and idempotently.
     */
    const settlements = [];
    const MAX_SETTLEMENTS_PER_RUN = 20;

    for (let i = 0; i < MAX_SETTLEMENTS_PER_RUN; i++) {
      const resultRows = await sql`
        SELECT settle_expired_round() AS settlement
      `;

      const settlement = resultRows[0]?.settlement;

      if (!settlement) {
        break;
      }

      if (
        settlement.success === false ||
        settlement.error
      ) {
        console.error("Settlement function reported an error");

        throw new Error("Round settlement failed");
      }

      settlements.push(settlement);

      /*
       * Stop when the function reports no work.
       * The exact message depends on the existing SQL function.
       */
      const message = String(settlement.message || "").toLowerCase();

      if (
        message.includes("no expired") ||
        message.includes("no unsettled") ||
        message.includes("nothing to settle")
      ) {
        settlements.pop();
        break;
      }

      /*
       * Avoid looping repeatedly if the function returns
       * the same result without settling another round.
       */
      if (settlements.length >= MAX_SETTLEMENTS_PER_RUN) {
        break;
      }
    }

    /*
     * 4. Ensure overdue betting windows are locked.
     */
    await sql`
      UPDATE game_rounds
      SET status = 'locked'
      WHERE status = 'open'
        AND betting_closes_at <= NOW()
        AND ends_at > NOW()
    `;

    /*
     * 5. Return current round and recent history.
     */
    const currentRows = await sql`
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
      WHERE starts_at <= NOW()
        AND ends_at > NOW()
      ORDER BY starts_at DESC
      LIMIT 1
    `;

    const recentRows = await sql`
      SELECT
        round_code,
        status,
        starts_at,
        betting_closes_at,
        ends_at,
        result_number,
        settled_at
      FROM game_rounds
      ORDER BY starts_at DESC
      LIMIT 10
    `;

    return res.status(200).json({
      success: true,
      message: "Round schedule and settlement checked",
      server_time: serverTime.toISOString(),
      rounds_created: createdRows.length,
      rounds_locked: lockedRows.length,
      settlements_processed: settlements.length,
      current_round: currentRows[0] || null,
      recent_rounds: recentRows
    });

  } catch (error) {
    console.error("Cron execution failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to update rounds or settle expired rounds"
    });
  }
};