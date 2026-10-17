const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({
      success: false,
      message: "Method not allowed.",
    });
  }

  const secret = process.env.CRON_SECRET;
  const authorization = req.headers.authorization || "";

  if (
    !secret ||
    authorization !== `Bearer ${secret}`
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const timeResult = await client.query(
      `SELECT
         NOW() AS db_now,
         FLOOR(EXTRACT(EPOCH FROM NOW()) / 180) * 180 AS slot_start`
    );

    const dbNow = new Date(timeResult.rows[0].db_now);
    const slotStart = Number(timeResult.rows[0].slot_start);

    const startsAt = new Date(slotStart * 1000);
    const bettingClosesAt = new Date((slotStart + 150) * 1000);
    const endsAt = new Date((slotStart + 180) * 1000);

    const roundCode = [
      startsAt.getUTCFullYear(),
      String(startsAt.getUTCMonth() + 1).padStart(2, "0"),
      String(startsAt.getUTCDate()).padStart(2, "0"),
      String(startsAt.getUTCHours()).padStart(2, "0"),
      String(startsAt.getUTCMinutes()).padStart(2, "0"),
      String(startsAt.getUTCSeconds()).padStart(2, "0"),
    ].join("");

    const status = dbNow < bettingClosesAt ? "open" : "locked";

    await client.query(
      `INSERT INTO game_rounds
         (round_code, status, starts_at, betting_closes_at, ends_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (round_code) DO NOTHING`,
      [roundCode, status, startsAt, bettingClosesAt, endsAt]
    );

    await client.query("COMMIT");

    let settled = 0;

    for (let i = 0; i < 20; i++) {
      const settleClient = await pool.connect();

      try {
        await settleClient.query("BEGIN");

        const result = await settleClient.query(
          "SELECT settle_expired_round() AS result"
        );

        await settleClient.query("COMMIT");

        const value = result.rows[0]?.result;

        if (
          !value ||
          value.success === false ||
          value.message === "No expired round to settle"
        ) {
          break;
        }

        if (value.settled === true || value.success === true) {
          settled++;
        } else {
          break;
        }
      } catch (error) {
        await settleClient.query("ROLLBACK").catch(() => {});
        console.error("Settlement error:", error);
        break;
      } finally {
        settleClient.release();
      }
    }

    const current = await pool.query(
      `SELECT round_code, status, starts_at,
              betting_closes_at, ends_at
       FROM game_rounds
       WHERE status = 'open'
         AND starts_at <= NOW()
         AND betting_closes_at > NOW()
         AND ends_at > NOW()
       ORDER BY starts_at DESC
       LIMIT 1`
    );

    return res.status(200).json({
      success: true,
      server_time: dbNow.toISOString(),
      created_or_checked_round: roundCode,
      settled_rounds: settled,
      current_round: current.rows[0] || null,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Cron error:", error);

    return res.status(500).json({
      success: false,
      message: "Cron execution failed.",
    });
  } finally {
    client.release();
  }
};