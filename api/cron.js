const { Pool } = require("pg");

const ROUND_SECONDS = 180;
const BETTING_SECONDS = 150;
const FUTURE_ROUNDS = 5;
const MAX_SETTLEMENT_ATTEMPTS = 20;

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is missing");
    }

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    });
  }

  return pool;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return false;
  }

  return (
    (req.headers.authorization || "") === `Bearer ${secret}`
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return sendJson(res, 405, {
      success: false,
      message: "Method not allowed"
    });
  }

  if (!authorized(req)) {
    return sendJson(res, 401, {
      success: false,
      message: "Unauthorized"
    });
  }

  let client;

  try {
    const db = getPool();
    client = await db.connect();

    // Calculate the current 180-second round slot.
    const timeResult = await client.query(
      `
      SELECT
        NOW() AS db_now,
        FLOOR(EXTRACT(EPOCH FROM NOW()) / $1) * $1
          AS current_slot
      `,
      [ROUND_SECONDS]
    );

    const dbNow = new Date(timeResult.rows[0].db_now);
    const currentSlot = Number(timeResult.rows[0].current_slot);

    if (!Number.isFinite(currentSlot)) {
      throw new Error("Could not calculate current round slot");
    }

    const finalSlot =
      currentSlot + FUTURE_ROUNDS * ROUND_SECONDS;

    // Find the latest round already stored in the database.
    const latestResult = await client.query(`
      SELECT starts_at
      FROM game_rounds
      ORDER BY starts_at DESC
      LIMIT 1
    `);

    let firstSlot = currentSlot;

    if (latestResult.rows.length > 0) {
      const latestStartMs = new Date(
        latestResult.rows[0].starts_at
      ).getTime();

      if (Number.isFinite(latestStartMs)) {
        const latestSlot =
          Math.floor(
            latestStartMs / 1000 / ROUND_SECONDS
          ) * ROUND_SECONDS;

        firstSlot = Math.min(
          currentSlot,
          latestSlot + ROUND_SECONDS
        );
      }
    }

    firstSlot = Math.min(firstSlot, currentSlot);

    let roundsCreated = 0;

    // Create all missing rounds up to the future-round buffer.
    // No fixed maximum number of rounds is imposed.
    for (
      let slot = firstSlot;
      slot <= finalSlot;
      slot += ROUND_SECONDS
    ) {
      const startsAt = new Date(slot * 1000);

      const bettingClosesAt = new Date(
        (slot + BETTING_SECONDS) * 1000
      );

      const endsAt = new Date(
        (slot + ROUND_SECONDS) * 1000
      );

      let status = "open";

      if (slot < currentSlot) {
        status = "locked";
      } else if (
        slot === currentSlot &&
        dbNow.getTime() >= bettingClosesAt.getTime()
      ) {
        status = "locked";
      }

      const roundCode = [
        startsAt.getUTCFullYear(),
        String(startsAt.getUTCMonth() + 1).padStart(2, "0"),
        String(startsAt.getUTCDate()).padStart(2, "0"),
        String(startsAt.getUTCHours()).padStart(2, "0"),
        String(startsAt.getUTCMinutes()).padStart(2, "0"),
        String(startsAt.getUTCSeconds()).padStart(2, "0")
      ].join("");

      const insertResult = await client.query(
        `
        INSERT INTO game_rounds (
          round_code,
          status,
          starts_at,
          betting_closes_at,
          ends_at
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (round_code) DO NOTHING
        RETURNING id
        `,
        [
          roundCode,
          status,
          startsAt,
          bettingClosesAt,
          endsAt
        ]
      );

      if (insertResult.rowCount > 0) {
        roundsCreated++;
      }
    }

    // Reopen eligible future rounds.
    const futureRoundsResult = await client.query(`
      UPDATE game_rounds
      SET status = 'open'
      WHERE status = 'locked'
        AND starts_at > NOW()
        AND betting_closes_at > NOW()
        AND ends_at > NOW()
        AND result_number IS NULL
        AND settled_at IS NULL
      RETURNING id
    `);

    // Reopen the current round if betting is still allowed.
    const openCurrentResult = await client.query(`
      UPDATE game_rounds
      SET status = 'open'
      WHERE status = 'locked'
        AND starts_at <= NOW()
        AND betting_closes_at > NOW()
        AND ends_at > NOW()
        AND result_number IS NULL
        AND settled_at IS NULL
      RETURNING id
    `);

    // Lock rounds when their betting window closes.
    const lockedResult = await client.query(`
      UPDATE game_rounds
      SET status = 'locked'
      WHERE status = 'open'
        AND betting_closes_at <= NOW()
        AND ends_at > NOW()
        AND result_number IS NULL
        AND settled_at IS NULL
      RETURNING id
    `);

    // Settle rounds eligible under the current SQL function.
    let settledCount = 0;

    for (
      let attempt = 0;
      attempt < MAX_SETTLEMENT_ATTEMPTS;
      attempt++
    ) {
      const settlementResult = await client.query(`
        SELECT settle_expired_round() AS settled_round
      `);

      const settledRound =
        settlementResult.rows[0]?.settled_round;

      // The SQL function returns no round_code when
      // there is no eligible round to settle.
      if (
        !settledRound ||
        typeof settledRound !== "object" ||
        !settledRound.round_code
      ) {
        break;
      }

      settledCount++;
    }

    // Fetch the round currently in progress.
    const currentResult = await client.query(`
      SELECT
        id,
        round_code,
        status,
        starts_at,
        betting_closes_at,
        ends_at,
        result_number
      FROM game_rounds
      WHERE starts_at <= NOW()
        AND ends_at > NOW()
      ORDER BY starts_at DESC
      LIMIT 1
    `);

    const serverTimeResult = await client.query(`
      SELECT NOW() AS server_time
    `);

    return sendJson(res, 200, {
      success: true,
      server_time: serverTimeResult.rows[0].server_time,
      current_round: currentResult.rows[0] || null,
      rounds_created: roundsCreated,
      future_rounds_opened: futureRoundsResult.rowCount,
      current_rounds_opened: openCurrentResult.rowCount,
      rounds_locked: lockedResult.rowCount,
      rounds_settled: settledCount,
      round_duration_seconds: ROUND_SECONDS,
      betting_duration_seconds: BETTING_SECONDS
    });

  } catch (error) {
    console.error("Cron error:", error);

    return sendJson(res, 500, {
      success: false,
      message: "Cron execution failed"
    });

  } finally {
    if (client) {
      client.release();
    }
  }
};