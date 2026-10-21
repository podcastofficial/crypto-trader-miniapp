"use strict";

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not configured.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});

pool.on("error", err =>
  console.error("Profile DB pool error:", err.code || err.name)
);

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(JSON.stringify(data));
}

function validRequest(req) {
  if (req.headers["x-admin-request"] !== "1") return false;

  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

function ipAddress(req) {
  return String(
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    ""
  ).split(",")[0].trim().slice(0, 100);
}

async function ensureProfileTables() {
  await query(`CREATE TABLE IF NOT EXISTS public.user_profiles (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    bio TEXT,
    avatar_url TEXT,
    wallet_address TEXT,
    country TEXT,
    language TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS profile_picture TEXT`);
  await query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS wallet_address TEXT`);
  await query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS country TEXT`);
  await query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS language TEXT`);
}

async function getProfileFromUser(userId) {
  const rows = await query(
    `SELECT u.id, u.telegram_id, u.username, u.first_name, u.last_name,
            u.profile_picture, u.wallet_address, u.country, u.language,
            w.balance,
            COALESCE(p.bio, '') AS bio,
            COALESCE(p.avatar_url, u.profile_picture, '') AS avatar_url
     FROM public.users u
     LEFT JOIN public.wallet_balances w ON w.user_id = u.id
     LEFT JOIN public.user_profiles p ON p.user_id = u.id
     WHERE u.id = $1
     LIMIT 1`,
    [userId]
  );

  return rows[0] || null;
}

async function profileAction(body, req) {
  await ensureProfileTables();

  const userId = String(body.user_id || "").trim();
  if (!/^\d{1,15}$/.test(userId)) throw new Error("Invalid user ID.");

  const action = String(body.action || "").trim();

  if (action === "get") {
    const profile = await getProfileFromUser(userId);
    if (!profile) return { ok: false, message: "User not found." };

    return {
      ok: true,
      profile: {
        id: profile.id,
        telegram_id: profile.telegram_id,
        username: profile.username,
        first_name: profile.first_name,
        last_name: profile.last_name,
        bio: profile.bio || "",
        avatar_url: profile.avatar_url || "",
        wallet_address: profile.wallet_address || "",
        balance: Number(profile.balance || 0),
        country: profile.country || "",
        language: profile.language || ""
      }
    };
  }

  if (action === "save") {
    const username = String(body.username || "").trim().slice(0, 80);
    const firstName = String(body.first_name || "").trim().slice(0, 80);
    const lastName = String(body.last_name || "").trim().slice(0, 80);
    const bio = String(body.bio || "").trim().slice(0, 500);
    const avatarUrl = String(body.avatar_url || "").trim().slice(0, 500);
    const walletAddress = String(body.wallet_address || "").trim().slice(0, 200);
    const country = String(body.country || "").trim().slice(0, 80);
    const language = String(body.language || "").trim().slice(0, 40);

    await query(
      `INSERT INTO public.user_profiles (
         user_id, username, first_name, last_name, bio, avatar_url, wallet_address, country, language, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         bio = EXCLUDED.bio,
         avatar_url = EXCLUDED.avatar_url,
         wallet_address = EXCLUDED.wallet_address,
         country = EXCLUDED.country,
         language = EXCLUDED.language,
         updated_at = NOW()`,
      [userId, username || null, firstName || null, lastName || null, bio || null, avatarUrl || null, walletAddress || null, country || null, language || null]
    );

    await query(
      `UPDATE public.users
       SET username = COALESCE(NULLIF($2, ''), username),
           first_name = COALESCE(NULLIF($3, ''), first_name),
           last_name = COALESCE(NULLIF($4, ''), last_name),
           profile_picture = COALESCE(NULLIF($5, ''), profile_picture),
           wallet_address = COALESCE(NULLIF($6, ''), wallet_address),
           country = COALESCE(NULLIF($7, ''), country),
           language = COALESCE(NULLIF($8, ''), language)
       WHERE id = $1`,
      [userId, username, firstName, lastName, avatarUrl, walletAddress, country, language]
    );

    return {
      ok: true,
      message: "Profile saved.",
      profile: await getProfileFromUser(userId)
    };
  }

  if (action === "wallet") {
    const walletAddress = String(body.wallet_address || "").trim().slice(0, 200);
    if (!walletAddress) throw new Error("Wallet address is required.");

    await query(
      `INSERT INTO public.user_profiles (user_id, wallet_address, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET wallet_address = EXCLUDED.wallet_address, updated_at = NOW()`,
      [userId, walletAddress]
    );

    await query(
      `UPDATE public.users
       SET wallet_address = $2
       WHERE id = $1`,
      [userId, walletAddress]
    );

    return {
      ok: true,
      wallet_address: walletAddress
    };
  }

  if (action === "avatar") {
    const avatarUrl = String(body.avatar_url || "").trim().slice(0, 500);
    if (!avatarUrl) throw new Error("Avatar URL is required.");

    await query(
      `INSERT INTO public.user_profiles (user_id, avatar_url, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET avatar_url = EXCLUDED.avatar_url, updated_at = NOW()`,
      [userId, avatarUrl]
    );

    await query(
      `UPDATE public.users
       SET profile_picture = $2
       WHERE id = $1`,
      [userId, avatarUrl]
    );

    return {
      ok: true,
      avatar_url: avatarUrl
    };
  }

  throw new Error("Unsupported profile action.");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { message: "Method not allowed." });
  }

  if (!validRequest(req)) {
    return json(res, 403, { message: "Request rejected." });
  }

  const body = req.body || {};
  const action = String(body.action || "").trim();

  try {
    const result = await profileAction(body, req);

    if (action === "get") {
      return json(res, 200, result);
    }

    return json(res, 200, result);
  } catch (error) {
    console.error("Profile API error:", error.code || error.name || "Error");

    let message = "Profile request failed.";

    if (error.message && /Invalid|Unsupported/.test(error.message)) {
      message = error.message;
    }

    return json(res, 400, { message });
  }
};
