const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

const ROUND_SECONDS = 180;
const BETTING_SECONDS = 150;

// Keep several future rounds ready.
const FUTURE_ROUNDS = 5;

// Limit historical backfill and settlement workload.
const MAX_ROUNDS_TO_CREATE = 100;
const MAX_SETTLEMENT_ATTEMPTS = 20;

function json(res, status, data) {
  return res.status(status).json(data);
}

function createRoundCode(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join("");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");

    return json(res, 405, {
      success: false,
      message: "Method not allowed.",
    });
  }

  const secret = process.env.CRON_SECRET;
  const authorization = req.headers.authorization || "";

  if (!secret || authorization !== `Bearer ${secret}`) {
    return json(res, 401, {
      success: false,
      message: "Unauthorized",
    });
  }

  let client;

  try {
    client = await pool.connect();

    await client.query("BEGIN");

    /*
     * Use PostgreSQL time as the source of truth.
     * All rounds align to UTC 3-minute boundaries.
     */
    const timeResult = await client.query(`
      SELECT
        NOW() AS db_now,
        FLOOR(
          EXTRACT(EPOCH FROM NOW()) / ${ROUND_SECONDS}
        ) * ${ROUND_SECONDS} AS slot_start
    `);

    const dbNow = new Date(timeResult.rows[0].db_now);
    const currentSlot = Number(timeResult.rows[0].slot_start);

    /*
     * Create rounds through five future slots.
     * This prevents the next round from waiting for
     * the next cron execution to be inserted.
     */
    const finalSlot =
      currentSlot + FUTURE_ROUNDS * ROUND_SECONDS;

    const existingResult = await client.query(`
      SELECT
        FLOOR(
          EXTRACT(EPOCH FROM starts_at) / ${ROUND_SECONDS}
        ) * ${ROUND_SECONDS} AS slot_start
      FROM game_rounds
      ORDER BY starts_at DESC
      LIMIT 1
    `);

    let firstSlot = currentSlot;

    if (existingResult.rows.length > 0) {
      const lastSlot = Number(existingResult.rows[0].slot_start);

      firstSlot = Math.min(
        currentSlot,
        lastSlot + ROUND_SECONDS
      );

      firstSlot = Math.max(
        firstSlot,
        currentSlot -
          (MAX_ROUNDS_TO_CREATE - 1) * ROUND_SECONDS
      );
    }

    let createdOrChecked = 0;

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

      const roundCode = createRoundCode(startsAt);

      /*
       * Future rounds must not be open before their
       * actual start time. Expired slots remain locked.
       */
      let status = "locked";

      if (
        dbNow >= startsAt &&
        dbNow < bettingClosesAt
      ) {
        status = "open";
      }

      await client.query(
        `INSERT INTO game_rounds (
           round_code,
           status,
           starts_at,
           betting_closes_at,
           ends_at
         )
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (round_code) DO NOTHING`,
        [
          roundCode,
          status,
          startsAt,
          bettingClosesAt,
          endsAt,
        ]
      );

      createdOrChecked++;
    }

    /*
     * Open the correct current round if it exists.
     * Do not reopen a round whose betting window closed.
     */
    await client.query(
      `UPDATE game_rounds
       SET status = 'open'
       WHERE starts_at <= NOW()
         AND betting_closes_at > NOW()
         AND ends_at > NOW()
         AND status = 'locked'`
    );

    /*
     * Lock rounds whose betting window has closed.
     */
    await client.query(
      `UPDATE game_rounds
       SET status = 'locked'
       WHERE status = 'open'
         AND betting_closes_at <= NOW()
         AND ends_at > NOW()`
    );

    await client.query("COMMIT");

    let settled = 0;
    let settlementErrors = 0;

    /*
     * Keep the existing database settlement function.
     */
    for (
      let i = 0;
      i < MAX_SETTLEMENT_ATTEMPTS;
      i++
    ) {
      const settleClient = await pool.connect();

      try {
        await settleClient.query("BEGIN");

        const result = await settleClient.query(
          "SELECT settle_expired_round() AS result"
        );

        await settleClient.query("COMMIT");

        const value = result.rows[0]?.result;

        if (!value) {
          break;
        }

        if (
          value.success === false ||
          value.message === "No expired round to settle"
        ) {
          break;
        }

        if (
          value.settled === true ||
          value.success === true
        ) {
          settled++;
          continue;
        }

        break;
      } catch (error) {
        await settleClient.query("ROLLBACK").catch(() => {});

        console.error("Settlement error:", error.message);

        settlementErrors++;
        break;
      } finally {
        settleClient.release();
      }
    }

    /*
     * Read the active round using database time.
     */
    const currentResult = await pool.query(
      `SELECT
         id,
         round_code,
         status,
         starts_at,
         betting_closes_at,
         ends_at
       FROM game_rounds
       WHERE starts_at <= NOW()
         AND ends_at > NOW()
       ORDER BY starts_at DESC
       LIMIT 1`
    );

    const current = currentResult.rows[0] || null;

    /*
     * Return database time after the work has completed.
     */
    const finalTimeResult = await pool.query(
      "SELECT NOW() AS server_time"
    );

    const serverTime = new Date(
      finalTimeResult.rows[0].server_time
    );

    return json(res, 200, {
      success: true,
      server_time: serverTime.toISOString(),
      created_or_checked_rounds: createdOrChecked,
      settled_rounds: settled,
      settlement_errors: settlementErrors,
      current_round: current,
      betting_open: Boolean(
        current &&
        current.status === "open" &&
        new Date(current.betting_closes_at) > serverTime
      ),
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("Cron error:", error);

    return json(res, 500, {
      success: false,
      message: "Cron execution failed.",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
};