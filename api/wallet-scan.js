"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000";

function json(res, status, data) {
  return res.status(status).json(data);
}

function getAddressTopic(address) {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function parseAddressTopic(topic) {
  if (!topic || !/^0x[0-9a-f]{64}$/i.test(topic)) {
    return null;
  }

  return "0x" + topic.slice(-40).toLowerCase();
}

async function rpc(method, params = []) {
  const endpoint = process.env.BSC_RPC_URL;

  if (!endpoint) {
    throw new Error("BSC_RPC_URL is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`BSC RPC HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || "BSC RPC error");
    }

    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBlockNumber(value) {
  if (!value || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error("Invalid block number from RPC.");
  }

  return BigInt(value);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return json(res, 405, {
      success: false,
      message: "Method not allowed.",
    });
  }

  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return json(res, 503, {
      success: false,
      message: "CRON_SECRET is not configured.",
    });
  }

  const authorization = req.headers.authorization || "";

  if (authorization !== `Bearer ${secret}`) {
    return json(res, 401, {
      success: false,
      message: "Unauthorized.",
    });
  }

  const tokenAddress = String(
    process.env.USDT_BEP20_TOKEN_ADDRESS || ""
  ).toLowerCase();

  const depositAddress = String(
    process.env.USDT_BEP20_DEPOSIT_ADDRESS || ""
  ).toLowerCase();

  const requiredConfirmations = Number(
    process.env.BSC_MIN_CONFIRMATIONS || "12"
  );

  if (
    !/^0x[a-f0-9]{40}$/.test(tokenAddress) ||
    !/^0x[a-f0-9]{40}$/.test(depositAddress) ||
    !Number.isInteger(requiredConfirmations) ||
    requiredConfirmations < 1 ||
    requiredConfirmations > 1000
  ) {
    return json(res, 503, {
      success: false,
      message: "BSC token, deposit address or confirmation settings are invalid.",
    });
  }

  let client;

  try {
    // Confirm RPC is reachable and get the current block.
    const headHex = await rpc("eth_blockNumber");
    const head = normalizeBlockNumber(headHex);

    const tokenCode = await rpc("eth_getCode", [
      tokenAddress,
      "latest",
    ]);

    if (!tokenCode || tokenCode === "0x") {
      return json(res, 503, {
        success: false,
        message: "No contract code found at the configured token address.",
      });
    }

    // Confirm the contract exposes decimals().
    const decimalsHex = await rpc("eth_call", [
      {
        to: tokenAddress,
        data: "0x313ce567",
      },
      "latest",
    ]);

    if (
      !decimalsHex ||
      !/^0x[0-9a-f]+$/i.test(decimalsHex)
    ) {
      return json(res, 503, {
        success: false,
        message: "Could not read token decimals.",
      });
    }

    const decimals = Number(BigInt(decimalsHex));

    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      return json(res, 503, {
        success: false,
        message: "Token decimals are invalid.",
      });
    }

    const safeHead =
      head >= BigInt(requiredConfirmations - 1)
        ? head - BigInt(requiredConfirmations - 1)
        : 0n;

    client = await pool.connect();

    // This lock is independent of the game cron lock.
    await client.query("BEGIN");

    const lockResult = await client.query(
      `SELECT pg_try_advisory_xact_lock(739184206) AS locked`
    );

    if (!lockResult.rows[0].locked) {
      await client.query("ROLLBACK");

      return json(res, 200, {
        success: true,
        skipped: true,
        message: "Another wallet scan is already running.",
      });
    }

    const stateResult = await client.query(
      `SELECT last_scanned_block
       FROM public.real_wallet_scan_state
       WHERE id = 1
       FOR UPDATE`
    );

    let lastScanned = stateResult.rowCount
      ? BigInt(stateResult.rows[0].last_scanned_block)
      : 0n;

    // Initial run starts near the chain head rather than scanning
    // the entire blockchain from genesis.
    if (lastScanned === 0n) {
      lastScanned = safeHead > 0n ? safeHead - 100n : 0n;
    }

    if (safeHead <= lastScanned) {
      await client.query("COMMIT");

      return json(res, 200, {
        success: true,
        message: "No new confirmed blocks to scan.",
        scannedThrough: lastScanned.toString(),
        decimals,
      });
    }

    // Keep each request bounded to avoid public RPC range limits.
    const maxBlocks = 500n;
    const fromBlock = lastScanned + 1n;
    const toBlock =
      safeHead - fromBlock + 1n > maxBlocks
        ? fromBlock + maxBlocks - 1n
        : safeHead;

    const logs = await rpc("eth_getLogs", [
      {
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
        address: tokenAddress,
        topics: [
          TRANSFER_TOPIC,
          null,
          getAddressTopic(depositAddress),
        ],
      },
    ]);

    if (!Array.isArray(logs)) {
      throw new Error("RPC returned invalid logs.");
    }

    const detected = [];

    for (const log of logs) {
      if (
        !log ||
        log.removed ||
        !Array.isArray(log.topics) ||
        log.topics.length < 3
      ) {
        continue;
      }

      const to = parseAddressTopic(log.topics[2]);

      if (to !== depositAddress) continue;

      if (
        !log.data ||
        !/^0x[0-9a-f]+$/i.test(log.data) ||
        !/^0x[0-9a-f]{64}$/i.test(log.transactionHash || "")
      ) {
        continue;
      }

      const rawAmount = BigInt(log.data);

      if (rawAmount <= 0n) continue;

      const blockNumber = normalizeBlockNumber(log.blockNumber);
      const confirmations = head - blockNumber + 1n;

      if (confirmations < BigInt(requiredConfirmations)) {
        continue;
      }

      detected.push({
        transactionHash: log.transactionHash.toLowerCase(),
        from: parseAddressTopic(log.topics[1]),
        to,
        rawAmount: rawAmount.toString(),
        blockNumber: blockNumber.toString(),
        confirmations: confirmations.toString(),
      });
    }

    // This version ONLY reports verified transfer events.
    // It intentionally does not credit wallet balances.
    await client.query(
      `UPDATE public.real_wallet_scan_state
       SET last_scanned_block = $1,
           updated_at = NOW()
       WHERE id = 1`,
      [toBlock.toString()]
    );

    await client.query("COMMIT");

    return json(res, 200, {
      success: true,
      message:
        "Confirmed transfer scan completed. No wallet balances were credited.",
      tokenAddress,
      depositAddress,
      tokenDecimals: decimals,
      requiredConfirmations,
      scannedFrom: fromBlock.toString(),
      scannedThrough: toBlock.toString(),
      detectedCount: detected.length,
      detectedTransfers: detected.slice(0, 50),
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }

    console.error("Wallet scanner error:", error.message);

    return json(res, 500, {
      success: false,
      message: "Wallet scan failed. Check RPC support and server logs.",
    });
  } finally {
    if (client) client.release();
  }
};