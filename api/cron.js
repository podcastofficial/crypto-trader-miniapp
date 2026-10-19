const { Pool } = require("pg");

const ROUND_SECONDS = 180;
const BETTING_SECONDS = 150;
const FUTURE_ROUNDS = 5;
const MAX_SETTLEMENT_ATTEMPTS = 20;
const RESULTS_CHANNEL = "@crypto_trader_results";

async function notifyResults(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: RESULTS_CHANNEL, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10000)
  }).catch(() => {});
}

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

const USDT_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55aeb5d5f9f";

async function scanDeposits(client) {
  const rpc = process.env.BSC_RPC_URL;
  const token = String(process.env.USDT_BEP20_TOKEN_ADDRESS || "").toLowerCase();
  const depositAddress = String(process.env.USDT_BEP20_DEPOSIT_ADDRESS || "").toLowerCase();
  if (!rpc || !/^0x[a-f0-9]{40}$/.test(token) || !/^0x[a-f0-9]{40}$/.test(depositAddress)) return 0;
  const call = async (method, params) => {
    const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || "BSC RPC error");
    return data.result;
  };
  const latest = parseInt(await call("eth_blockNumber", []), 16);
  const fromBlock = Math.max(0, latest - 2000);
  const paddedTo = `0x${depositAddress.slice(2).padStart(64, "0")}`;
  const logs = await call("eth_getLogs", [{ address: token, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${latest.toString(16)}`, topics: [USDT_TRANSFER_TOPIC, null, paddedTo] }]);
  let credited = 0;
  for (const log of logs || []) {
    const txHash = String(log.transactionHash || "");
    if (!/^0x[0-9a-f]{64}$/i.test(txHash)) continue;
    const confirmations = Math.max(0, latest - parseInt(String(log.blockNumber || "0"), 16) + 1);
    const requiredConfirmations = Math.max(1, Number(process.env.BSC_MIN_CONFIRMATIONS || 12));
    if (confirmations < requiredConfirmations) continue;
    const raw = BigInt(log.data || "0x0");
    const usdt = Number(raw) / 1e6;
    const points = usdt * 100;
    if (!Number.isFinite(points) || points < 100) continue;
    const submitted = await client.query("SELECT id,user_id,status FROM public.transactions WHERE LOWER(tx_hash)=LOWER($1) AND transaction_type='deposit' LIMIT 1", [txHash]);
    const userWallet = submitted.rowCount ? null : await client.query("SELECT user_id FROM public.user_wallets WHERE LOWER(wallet_address)=LOWER($1) LIMIT 1", [depositAddress]);
    const userId = submitted.rows[0]?.user_id || userWallet?.rows[0]?.user_id;
    if (!userId || (submitted.rowCount && submitted.rows[0].status === "confirmed")) continue;
    const inserted = submitted.rowCount
      ? await client.query(`UPDATE public.transactions SET amount=$1,status='confirmed',network='BSC',updated_at=NOW() WHERE id=$2 RETURNING id`, [points.toFixed(2), submitted.rows[0].id])
      : await client.query(`INSERT INTO public.transactions (user_id, transaction_type, amount, status, network, tx_hash, created_at, updated_at) SELECT $1,'deposit',$2,'confirmed','BSC',$3,NOW(),NOW() WHERE NOT EXISTS (SELECT 1 FROM public.transactions WHERE tx_hash=$3) RETURNING id`, [userId, points.toFixed(2), txHash]);
    if (inserted.rowCount) {
      await client.query(`INSERT INTO public.wallet_balances (user_id,balance,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (user_id) DO UPDATE SET balance=public.wallet_balances.balance+EXCLUDED.balance,updated_at=NOW()`, [userId, points.toFixed(2)]);
      credited++;
    }
  }
  return credited;
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;

  return Boolean(
    secret &&
    req.headers.authorization === `Bearer ${secret}`
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
    client = await getPool().connect();

    await client.query("BEGIN");

    // Serialize cron executions.
    await client.query(
      "SELECT pg_advisory_xact_lock($1::bigint)",
      [739184205]
    );

    const timeResult = await client.query(
      `
        SELECT
          NOW() AS db_now,
          FLOOR(
            EXTRACT(EPOCH FROM NOW()) / $1
          ) * $1 AS current_slot
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

    const latestResult = await client.query(`
      SELECT starts_at
      FROM public.game_rounds
      ORDER BY starts_at DESC
      LIMIT 1
    `);

    let firstSlot = currentSlot;

    if (latestResult.rows.length > 0) {
      const latestStartMs =
        new Date(latestResult.rows[0].starts_at).getTime();

      if (Number.isFinite(latestStartMs)) {
        const latestSlot =
          Math.floor(latestStartMs / 1000 / ROUND_SECONDS) *
          ROUND_SECONDS;

        firstSlot = Math.min(
          currentSlot,
          latestSlot + ROUND_SECONDS
        );
      }
    }

    firstSlot = Math.min(firstSlot, currentSlot);

    let roundsCreated = 0;

    // Create missing rounds.
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

      const inserted = await client.query(
        `
          INSERT INTO public.game_rounds (
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
  [roundCode, "open", startsAt, bettingClosesAt, endsAt]
  );
  if (inserted.rowCount) {
    const seed = [...roundCode].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const predictedNumber = seed % 10;
    const predictedColour = ["Red", "Green", "Violet"][seed % 3];
    await notifyResults(`🔮 Prediction (not guaranteed)\n🔢 Round: ${roundCode}\n🎯 Suggested number: ${predictedNumber}\n🎨 Suggested colour: ${predictedColour}\n⚠️ Informational estimate only — play responsibly.`);
  }

      roundsCreated += inserted.rowCount;
    }

    // Reopen future rounds only if no result has been calculated.
    const futureOpened = await client.query(`
      UPDATE public.game_rounds
      SET status = 'open'
      WHERE status = 'locked'
        AND starts_at > NOW()
        AND betting_closes_at > NOW()
        AND ends_at > NOW()
        AND result_number IS NULL
        AND settled_at IS NULL
      RETURNING id
    `);

    // Reopen the current round only during its betting window.
    const currentOpened = await client.query(`
      UPDATE public.game_rounds
      SET status = 'open'
      WHERE status = 'locked'
        AND starts_at <= NOW()
        AND betting_closes_at > NOW()
        AND ends_at > NOW()
        AND result_number IS NULL
        AND settled_at IS NULL
      RETURNING id
    `);

    // Lock betting when the betting window closes.
    const locked = await client.query(`
      UPDATE public.game_rounds
      SET status = 'locked'
      WHERE status = 'open'
        AND betting_closes_at <= NOW()
        AND ends_at > NOW()
        AND result_number IS NULL
        AND settled_at IS NULL
      RETURNING id
    `);

    let resultsCalculated = 0;
    let payoutsReleased = 0;

    // The database function may return one combined step
    // (no phase) or separate phases.
    for (
      let attempt = 0;
      attempt < MAX_SETTLEMENT_ATTEMPTS;
      attempt++
    ) {
      const settlement = await client.query(`
        SELECT public.settle_expired_round() AS settled_round
      `);

      const result = settlement.rows[0]?.settled_round;

      if (
        !result ||
        typeof result !== "object" ||
        !result.round_code
      ) {
        break;
      }

      if (result.phase === "result_calculated") {
        resultsCalculated++;
        await notifyResults(`🎲 Round result published\n🔢 Round: ${result.round_code}\n🎯 Result: ${result.result_number ?? "—"}\n🎨 Colour: ${result.result_color ?? "—"}\n📏 Size: ${result.result_size ?? "—"}`);
      } else if (result.phase === "payout_released") {
        payoutsReleased++;
      } else if (!result.phase) {
        // Current database function calculates the result
        // and releases payouts in one step.
        resultsCalculated++;
        payoutsReleased++;
      } else {
        throw new Error(
          `Unexpected settlement phase: ${result.phase}`
        );
      }
    }

    const currentResult = await client.query(`
      SELECT
        id,
        round_code,
        status,
        starts_at,
        betting_closes_at,
        ends_at
      FROM public.game_rounds
      WHERE starts_at <= NOW()
        AND ends_at > NOW()
      ORDER BY starts_at DESC
      LIMIT 1
    `);

    const depositsCredited = await scanDeposits(client);

    const serverTimeResult = await client.query(`
  SELECT NOW() AS server_time
  `);

  await client.query("COMMIT");

    return sendJson(res, 200, {
      success: true,
      server_time: serverTimeResult.rows[0].server_time,
      current_round: currentResult.rows[0] || null,
      rounds_created: roundsCreated,
      future_rounds_opened: futureOpened.rowCount,
      current_rounds_opened: currentOpened.rowCount,
      rounds_locked: locked.rowCount,
      results_calculated: resultsCalculated,
      payouts_released: payoutsReleased,
      round_duration_seconds: ROUND_SECONDS,
      betting_duration_seconds: BETTING_SECONDS
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

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
