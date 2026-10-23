const { Pool } = require("pg");

const ROUND_SECONDS = 180;
const BETTING_SECONDS = 150;
const FUTURE_ROUNDS = 5;
const MAX_SETTLEMENT_ATTEMPTS = 20;
const RESULTS_CHANNEL = "@crypto_trader_results";

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

const USDT_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

// 🚨 NEW: 14-digit code ko 12-digit serial number me convert karne ke liye
function slotOfRound(code) {
  const m = String(code || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return 0;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 180000);
}

// Batch windows like "10:00-12:00,18:00-22:00" in IST (UTC+5:30). Empty = always on.
function inBatchWindow(windows, slotStartMs) {
  const w = String(windows || "").trim();
  if (!w) return true;
  const d = new Date(slotStartMs + 330 * 60000);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return w.split(",").some(part => {
    const m = part.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
    if (!m) return false;
    const from = +m[1] * 60 + +m[2];
    const to = +m[3] * 60 + +m[4];
    return from <= to ? (mins >= from && mins < to) : (mins >= from || mins < to);
  });
}

function fmtPeriod(code) {
  const raw = String(code || "");
  if (!/^\d{14}$/.test(raw)) return raw.slice(0, 12);
  const day = raw.slice(0, 8);
  const hour = Number(raw.slice(8, 10));
  const minute = Number(raw.slice(10, 12));
  const serial = Math.floor((hour * 60 + minute) / 3) + 1;
  return `${day}${String(serial).padStart(4, "0")}`;
}

// ==========================================
// CHANNEL SETTINGS & MULTI-CHANNEL TELEGRAM SYSTEM
// ==========================================
async function getChannelSettings(client) {
  try {
    const r = await client.query(
      `SELECT * FROM public.channel_settings WHERE id=1`
    );
    return r.rows[0] || {};
  } catch (_) {
    return {}; 
  }
}

function sizeOfNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? (x >= 5 ? "Big" : "Small") : "—";
}

function nowUtcTime() {
  return new Date().toISOString().slice(11, 19);
}

// Fills {placeholders} in a template. Unknown placeholders stay unchanged.
function fillTemplate(tpl, vars) {
  return String(tpl || "")
    .replace(/\\n/g, "\n")
    // Never publish win ratio / bet counts: drop any line that contains those placeholders
    .split("\n")
    .filter(line => !/\{(win_ratio|loss_ratio|win_rate|loss_rate|bets|bet_count|total_bets|total_stake|stake|payout|winners)\}/i.test(line))
    .join("\n")
    .replace(/\{(\w+)\}/g, (m, key) => {
      const v = vars[key.toLowerCase()];
      return v === undefined || v === null ? m : String(v);
    });
}

async function getRatios(client) {
  try {
    const hist = await client.query(`SELECT result FROM public.prediction_history WHERE result IS NOT NULL`);
    const total = hist.rowCount;
    const wins = hist.rows.filter(r => r.result === "win").length;
    const win = total > 0 ? ((wins / total) * 100).toFixed(1) : "0.0";
    const loss = total > 0 ? (100 - Number(win)).toFixed(1) : "0.0";
    return { win, loss };
  } catch (_) {
    return { win: "0.0", loss: "0.0" };
  }
}

async function sendTelegramMessage(client, type, data) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  try {
    const settings = await getChannelSettings(client);
    const botName = settings.bot_username || "YourBot";
    if (settings.channel_updates_enabled === false) return;
    const slot = slotOfRound(data.round);
    if (!inBatchWindow(settings.batch_windows, slot * 180000)) return;

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { 
            text: settings.inline_link_text || "🚀 Play Now", 
            url: `https://t.me/${botName}?start=game` 
          }
        ]
      ]
    };

    // Gather all active channels (Main + Extra)
    const channels = new Set();
    if (settings.channel_username) channels.add(settings.channel_username);

    try {
      const extraChannels = await client.query(`SELECT channel_id, schedule_mins FROM public.prediction_channels WHERE is_active = TRUE`);
      for (const row of extraChannels.rows) {
        const every = Math.max(1, Math.round((Number(row.schedule_mins) || 3) / 3));
        if (slot % every === 0) channels.add(row.channel_id);
      }
    } catch (e) { /* Table might not exist on first run */ }

    const channelList = Array.from(channels);
    if (channelList.length === 0) return;

    if (type === 'prediction') {
      if (settings.predictions_enabled === false) return;

      let text = settings.prediction_message || 
        "🔮 Prediction (not guaranteed)\n🔢 Round: {round}\n🎯 Suggested number: {number}\n🎨 Suggested colour: {colour}";

      // Replace literal \n with actual newlines, and variables
      text = fillTemplate(text, {
        round: fmtPeriod(data.round), period: fmtPeriod(data.round),
        number: data.number, prediction: data.number,
        colour: data.colour, color: data.colour,
        size: sizeOfNumber(data.number),
        time: nowUtcTime()
      });

      for (const chatId of channelList) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: "HTML",
            reply_markup: inlineKeyboard,
            disable_web_page_preview: true
          })
        }).catch(err => console.error("Telegram Error:", err.message));
      }
    }

    if (type === 'result') {
      await client.query(
        `UPDATE public.prediction_history 
         SET actual_number=$1, actual_colour=$2, result=$3 
         WHERE round_code=$4`,
        [
          data.result_number, 
          data.result_colour, 
          data.is_win ? 'win' : 'loss', 
          data.round
        ]
      );

      const predRow = await client.query(`SELECT predicted_number, predicted_colour FROM public.prediction_history WHERE round_code=$1 ORDER BY id ASC LIMIT 1`, [data.round]);

      let text = settings.result_message || 
        "🎲 Round result published\n🔢 Round: {round}\n🎯 Result: {number}\n🎨 Colour: {colour}\n📏 Size: {size}";

      text = fillTemplate(text, {
        round: fmtPeriod(data.round), period: fmtPeriod(data.round),
        number: data.result_number, result: data.result_number,
        colour: data.result_colour, color: data.result_colour,
        size: data.result_size,
        time: nowUtcTime(),
        prediction: predRow.rows[0] ? predRow.rows[0].predicted_number : "—",
        predicted_colour: predRow.rows[0] ? predRow.rows[0].predicted_colour : "—",
        status: data.is_win ? "WIN" : "LOSS"
      });

      for (const chatId of channelList) {
        if (settings.result_image_url && settings.result_image_url.startsWith("http")) {
          await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              photo: settings.result_image_url,
              caption: text,
              parse_mode: "HTML",
              reply_markup: inlineKeyboard
            })
          }).catch(err => console.error("Telegram Error:", err.message));
        } else {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: text,
              parse_mode: "HTML",
              reply_markup: inlineKeyboard,
              disable_web_page_preview: true
            })
          }).catch(err => console.error("Telegram Error:", err.message));
        }
      }
    }
  } catch (error) {
    console.error("Telegram Notification Error:", error.message);
  }
}

// ==========================================
// DEPOSIT SCANNER (FULLY INCLUDED)
// ==========================================
async function scanDeposits(client) {
  const rpc = process.env.BSC_RPC_URL;
  const token = normalizeAddress(process.env.USDT_BEP20_TOKEN_ADDRESS);
  const depositAddress = normalizeAddress(process.env.USDT_BEP20_DEPOSIT_ADDRESS);

  if (
    !rpc || 
    !/^0x[a-f0-9]{40}$/.test(token) || 
    !/^0x[a-f0-9]{40}$/.test(depositAddress)
  ) {
    return 0;
  }

  const call = async (method, params) => {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params
      })
    });

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || "BSC RPC error");
    }

    return data.result;
  };

  const latest = parseInt(await call("eth_blockNumber", []), 16);
  const blockRange = 100;
  const fromBlock = Math.max(0, latest - blockRange);
  const chunkSize = 5;
  const paddedTo = `0x${depositAddress.slice(2).padStart(64, "0")}`;

  let allLogs = [];

  for (let i = fromBlock; i <= latest; i += chunkSize) {
    const toBlockChunk = Math.min(i + chunkSize - 1, latest);
    try {
      const chunkLogs = await call("eth_getLogs", [
        {
          address: token,
          fromBlock: `0x${i.toString(16)}`,
          toBlock: `0x${toBlockChunk.toString(16)}`,
          topics: [USDT_TRANSFER_TOPIC, null, paddedTo]
        }
      ]);
      if (chunkLogs && chunkLogs.length > 0) {
        allLogs.push(...chunkLogs);
      }
    } catch (err) {
      console.error(`Deposit scan chunk error (${i}-${toBlockChunk}):`, err.message);
    }
    await new Promise(res => setTimeout(res, 150));
  }

  let credited = 0;

  for (const log of allLogs) {
    const txHash = String(log.transactionHash || "");
    if (!/^0x[0-9a-f]{64}$/i.test(txHash)) continue;

    const confirmations = Math.max(
      0, 
      latest - parseInt(String(log.blockNumber || "0"), 16) + 1
    );

    const requiredConfirmations = Math.max(
      1, 
      Number(process.env.BSC_MIN_CONFIRMATIONS || 3)
    );

    if (confirmations < requiredConfirmations) continue;

    const raw = BigInt(log.data || "0x0");
    const usdt = Number(raw) / 1e18;
    const points = usdt * 100;

    if (!Number.isFinite(points) || points < 100) continue;

    const submitted = await client.query(
      `SELECT id, user_id, status
       FROM public.transactions
       WHERE LOWER(tx_hash)=LOWER($1)
         AND transaction_type='deposit'
       LIMIT 1`,
      [txHash]
    );

    let userId = submitted.rows[0]?.user_id ?? null;

    if (!userId) {
      const walletRow = await client.query(
        `SELECT user_id
         FROM public.user_wallets
         WHERE LOWER(wallet_address)=LOWER($1)
         LIMIT 1`,
        [depositAddress]
      );

      userId = walletRow.rows[0]?.user_id ?? null;
    }

    if (
      !userId || 
      (submitted.rowCount && ['confirmed', 'completed'].includes(submitted.rows[0].status))
    ) {
      continue;
    }

    if (submitted.rowCount) {
      await client.query(
        `UPDATE public.transactions
         SET amount=$1, status='confirmed', network='BSC', updated_at=NOW()
         WHERE id=$2`,
        [points.toFixed(2), submitted.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO public.transactions (
           user_id, transaction_type, amount, status, network, tx_hash, created_at, updated_at
         )
         SELECT $1, 'deposit', $2, 'confirmed', 'BSC', $3, NOW(), NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM public.transactions
           WHERE LOWER(tx_hash)=LOWER($3) AND transaction_type='deposit'
         )`,
        [userId, points.toFixed(2), txHash]
      );
    }

    await client.query(
      `INSERT INTO public.wallet_balances (user_id, balance, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET
         balance = public.wallet_balances.balance + EXCLUDED.balance,
         updated_at = NOW()`,
      [userId, points.toFixed(2)]
    );

    credited++;
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

// ==========================================
// MAIN HANDLER
// ==========================================
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

    await client.query(
      "SELECT pg_advisory_xact_lock($1::bigint)",
      [739184205]
    );

    // Database tables safety check
    try { 
      await client.query(`SELECT 1 FROM public.channel_settings LIMIT 1`); 
    } catch (e) {
      await client.query(`CREATE TABLE IF NOT EXISTS public.channel_settings (
        id INT PRIMARY KEY DEFAULT 1, 
        channel_username TEXT DEFAULT '@crypto_trader_results', 
        bot_username TEXT DEFAULT 'YourBot', 
        predictions_enabled BOOLEAN DEFAULT TRUE, 
        prediction_timing INT DEFAULT 150, 
        prediction_message TEXT, 
        result_message TEXT, 
        result_image_url TEXT, 
        inline_link_text TEXT DEFAULT 'Play'
      )`);
      await client.query(`INSERT INTO public.channel_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
    }

    // Add sent_at to prediction history for tracking prediction message sent status
    await client.query(`ALTER TABLE public.prediction_history ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ`);

    // Create extra channels table for multi-channel support
    await client.query(`CREATE TABLE IF NOT EXISTS public.prediction_channels (
      id BIGSERIAL PRIMARY KEY, 
      channel_id TEXT NOT NULL UNIQUE,
      is_active BOOLEAN DEFAULT TRUE, 
      schedule_mins INT DEFAULT 3, 
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    const timeResult = await client.query(
      `
        SELECT
          NOW() AS db_now,
          FLOOR(EXTRACT(EPOCH FROM NOW()) / $1) * $1 AS current_slot
      `,
      [ROUND_SECONDS]
    );

    const dbNow = new Date(timeResult.rows[0].db_now);
    const currentSlot = Number(timeResult.rows[0].current_slot);

    if (!Number.isFinite(currentSlot)) {
      throw new Error("Could not calculate current round slot");
    }

    const finalSlot = currentSlot + FUTURE_ROUNDS * ROUND_SECONDS;

    const latestResult = await client.query(`
      SELECT starts_at
      FROM public.game_rounds
      ORDER BY starts_at DESC
      LIMIT 1
    `);

    let firstSlot = currentSlot;

    if (latestResult.rows.length > 0) {
      const latestStartMs = new Date(latestResult.rows[0].starts_at).getTime();

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

    for (
      let slot = firstSlot;
      slot <= finalSlot;
      slot += ROUND_SECONDS
    ) {
      const startsAt = new Date(slot * 1000);
      const bettingClosesAt = new Date((slot + BETTING_SECONDS) * 1000);
      const endsAt = new Date((slot + ROUND_SECONDS) * 1000);

      // 🚨 FIX: Wapas 14-digit code generate kar rahe hain (API validation ke liye)
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
            round_code, status, starts_at, betting_closes_at, ends_at
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (round_code) DO NOTHING
          RETURNING id
        `,
        [roundCode, "open", startsAt, bettingClosesAt, endsAt]
      );

      if (inserted.rowCount) {
        roundsCreated++;

        const seed = [...roundCode].reduce((sum, char) => sum + char.charCodeAt(0), 0);
        const predictedNumber = Math.floor(Math.random() * 10);
        const predictedColour = (predictedNumber === 0 || predictedNumber === 5) ? "Violet" : (predictedNumber % 2 === 0 ? "Red" : "Green");

        await client.query(
          `INSERT INTO public.prediction_history (round_code, predicted_number, predicted_colour) VALUES ($1, $2, $3)`,
          [roundCode, predictedNumber, predictedColour]
        );
      }
    }

    await client.query(`
      UPDATE public.game_rounds
      SET status = 'open'
      WHERE status = 'locked'
        AND starts_at > NOW()
        AND betting_closes_at > NOW()
        AND ends_at > NOW()
        AND result_number IS NULL
        AND settled_at IS NULL
    `);

    await client.query(`
      UPDATE public.game_rounds
      SET status = 'open'
      WHERE status = 'locked'
        AND starts_at <= NOW()
        AND betting_closes_at > NOW()
        AND ends_at > NOW()
        AND result_number IS NULL
        AND settled_at IS NULL
    `);

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

    // ==========================================
    // PREDICTION SENDING LOGIC BASED ON TIMING
    // ==========================================
    const activeRoundRes = await client.query(`
      SELECT r.round_code, r.starts_at, p.predicted_number, p.predicted_colour
      FROM public.game_rounds r
      JOIN public.prediction_history p ON p.round_code = r.round_code
      WHERE r.status = 'open' AND r.ends_at > NOW() AND p.sent_at IS NULL
      ORDER BY r.starts_at DESC LIMIT 1
    `);

    if (activeRoundRes.rows.length > 0) {
      const r = activeRoundRes.rows[0];
      const settings = await getChannelSettings(client);
      const timing = Number(settings.prediction_timing) || 150;
      const startMs = new Date(r.starts_at).getTime();
      const nowMs = dbNow.getTime();

      // Send prediction only when it's the right time (e.g. 30 seconds after round starts for 150s timing)
      const sendAtMs = startMs + (ROUND_SECONDS - timing) * 1000;

      if (nowMs >= sendAtMs) {
        await sendTelegramMessage(client, 'prediction', {
          round: r.round_code,
          number: r.predicted_number,
          colour: r.predicted_colour
        });
        // Mark as sent so it doesn't spam
        await client.query(`UPDATE public.prediction_history SET sent_at = NOW() WHERE round_code = $1`, [r.round_code]);
      }
    }
    // ==========================================

    let resultsCalculated = 0;
    let payoutsReleased = 0;

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

        const pred = await client.query(
          `SELECT predicted_number FROM public.prediction_history WHERE round_code=$1`, 
          [result.round_code]
        );

        const isWin = pred.rowCount && Number(pred.rows[0].predicted_number) === Number(result.result_number);

        await sendTelegramMessage(client, 'result', {
          round: result.round_code,
          result_number: result.result_number ?? "—",
          result_colour: result.result_color ?? "—",
          result_size: result.result_size ?? "—",
          is_win: isWin
        });

      } else if (result.phase === "payout_released") {
        payoutsReleased++;
      } else if (!result.phase) {
        resultsCalculated++;
        payoutsReleased++;
      }
    }

    const currentResult = await client.query(`
      SELECT
        id, round_code, status, starts_at, betting_closes_at, ends_at
      FROM public.game_rounds
      WHERE starts_at <= NOW()
        AND ends_at > NOW()
      ORDER BY starts_at DESC
      LIMIT 1
    `);

    let depositsCredited = 0;
    try {
      await client.query("SAVEPOINT deposit_scan");
      depositsCredited = await scanDeposits(client);
      await client.query("RELEASE SAVEPOINT deposit_scan");
    } catch (scanError) {
      await client.query("ROLLBACK TO SAVEPOINT deposit_scan").catch(() => {});
      console.error("Deposit scan failed:", scanError.message);
    }

    const serverTimeResult = await client.query(`
      SELECT NOW() AS server_time
    `);

    await client.query("COMMIT");

    return sendJson(res, 200, {
      success: true,
      server_time: serverTimeResult.rows[0].server_time,
      current_round: currentResult.rows[0] || null,
      rounds_created: roundsCreated,
      rounds_locked: locked.rowCount,
      results_calculated: resultsCalculated,
      payouts_released: payoutsReleased,
      deposits_credited: depositsCredited,
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
      message: "Cron execution failed",
      detail: String(error && error.message ? error.message : error).slice(0, 300)
    });
  } finally {
    if (client) {
      client.release();
    }
  }
};