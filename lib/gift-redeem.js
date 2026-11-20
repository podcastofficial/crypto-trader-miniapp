"use strict";

// Server-side gift code redemption (used by the Telegram bot when someone opens a
// t.me/<bot>?start=gift_CODE link). Same rules as the "redeem_gift" action in api/game.js.

const GIFT_SETUP = [
  `ALTER TABLE public.gift_codes ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'fixed'`,
  `ALTER TABLE public.gift_codes ADD COLUMN IF NOT EXISTS total_points NUMERIC(20,2)`,
  `ALTER TABLE public.gift_codes ADD COLUMN IF NOT EXISTS per_user_points NUMERIC(20,2)`,
  `ALTER TABLE public.gift_codes ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE public.gift_codes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
  `ALTER TABLE public.gift_code_redemptions ADD COLUMN IF NOT EXISTS points_earned NUMERIC(20,2)`
];

/**
 * Creates the Telegram user if needed and redeems the gift code for them.
 * @returns {{success:true, points:number} | {success:false, message:string}}
 */
async function redeemGiftForTelegramUser(pool, from, rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,64}$/.test(code)) {
    return { success: false, message: "This gift code is not valid." };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const u = await client.query(
      `INSERT INTO public.users (telegram_id, username)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
       RETURNING id`,
      [String(from.id), from.username || null]
    );
    const userId = u.rows[0].id;

    const blocked = await client.query(
      `SELECT COALESCE(is_blocked, FALSE) AS b FROM public.users WHERE id = $1`,
      [userId]
    ).catch(() => ({ rows: [] }));
    if (blocked.rows[0] && blocked.rows[0].b === true) {
      await client.query("ROLLBACK");
      return { success: false, message: "Your account is blocked." };
    }

    await client.query(
      `INSERT INTO public.wallet_balances (user_id, balance) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    for (const sql of GIFT_SETUP) await client.query(sql);

    const gift = await client.query(
      `SELECT * FROM public.gift_codes
        WHERE UPPER(code) = $1 AND uses < max_uses
          AND (expires_at IS NULL OR expires_at > NOW())
          AND COALESCE(is_active, TRUE) = TRUE AND deleted_at IS NULL
        FOR UPDATE`,
      [code]
    );
    if (!gift.rowCount) {
      await client.query("ROLLBACK");
      return { success: false, message: "Gift code is invalid, expired, or already used." };
    }
    const g = gift.rows[0];

    const used = await client.query(
      `SELECT 1 FROM public.gift_code_redemptions WHERE gift_code_id = $1 AND user_id = $2`,
      [g.id, userId]
    );
    if (used.rowCount) {
      await client.query("ROLLBACK");
      return { success: false, message: "You have already redeemed this gift code." };
    }

    let pts;
    if (g.mode === "distribution") {
      const sum = await client.query(
        `SELECT COALESCE(SUM(points_earned), 0) AS s FROM public.gift_code_redemptions WHERE gift_code_id = $1`,
        [g.id]
      );
      const remaining = Number(g.total_points) - Number(sum.rows[0].s);
      const usesLeft = Number(g.max_uses) - Number(g.uses);
      if (remaining <= 0) {
        await client.query("ROLLBACK");
        return { success: false, message: "Gift code is invalid, expired, or already used." };
      }
      if (usesLeft <= 1) pts = remaining;
      else {
        pts = Math.floor(Math.random() * (remaining / usesLeft) * 2 * 100) / 100;
        pts = Math.max(0.01, Math.min(pts, remaining - 0.01 * (usesLeft - 1)));
      }
    } else {
      pts = Number(g.per_user_points ?? g.points);
    }
    pts = Number(pts.toFixed(2));

    await client.query(
      `INSERT INTO public.gift_code_redemptions (gift_code_id, user_id, points_earned) VALUES ($1, $2, $3)`,
      [g.id, userId, pts]
    );
    await client.query(`UPDATE public.gift_codes SET uses = uses + 1 WHERE id = $1`, [g.id]);
    await client.query(
      `UPDATE public.wallet_balances SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2`,
      [pts, userId]
    );

    await client.query("SAVEPOINT sp_gift_tx");
    try {
      await client.query(
        `INSERT INTO public.transactions (user_id, transaction_type, amount, status, created_at, updated_at)
         VALUES ($1, 'gift', $2, 'completed', NOW(), NOW())`,
        [userId, pts]
      );
      await client.query("RELEASE SAVEPOINT sp_gift_tx");
    } catch (_) {
      await client.query("ROLLBACK TO SAVEPOINT sp_gift_tx");
    }

    await client.query("SAVEPOINT sp_gift_notif");
    try {
      await client.query(
        `INSERT INTO public.user_notifications (user_id, kind, title, message)
         VALUES ($1, 'gift', 'Gift code redeemed', $2)`,
        [userId, `You received ${pts.toFixed(2)} points from gift code ${code}.`]
      );
      await client.query("RELEASE SAVEPOINT sp_gift_notif");
    } catch (_) {
      await client.query("ROLLBACK TO SAVEPOINT sp_gift_notif");
    }

    await client.query("COMMIT");
    return { success: true, points: pts };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { redeemGiftForTelegramUser };
