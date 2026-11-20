"use strict";

// ============================================================================
// Game DB objects: tables + the two SQL functions the app calls.
//
//   public.place_bet_atomic(bigint, text, text, smallint, numeric, uuid)
//   public.settle_expired_round()
//
// These live in the database (not in the repo), so a new / restored / partially
// migrated Neon database does not have them. api/game.js and api/cron.js call
// ensureGameFunctions() once per server instance; it only creates what is
// missing, so it is safe to run any number of times.
//
// The same SQL is also available as db/migrations/001_game_functions.sql
// (generated from this file) if you prefer to run it by hand in the Neon SQL editor.
//
// Business rules (same as api/admin.js setResult and the UI):
//   stake      = amount x multiplier (the client already sends the total)
//   fee        = 2% of stake, debited together with the stake
//   payout     = (stake - fee) x  Number 9 | Colour 2 | Violet 4.5 | Big/Small 2
//                (Red on 0 and Green on 5 pay 0.5x)
//   referral   = commission on the fee: L1 15%, L2 10%, L3 5%
// ============================================================================

const LOCK_KEY = 739184206; // different from the cron lock (739184205)

const BET_SIGNATURE = "public.place_bet_atomic(bigint,text,text,smallint,numeric,uuid)";
const SETTLE_SIGNATURE = "public.settle_expired_round()";

const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS public.wallet_balances (
    user_id BIGINT PRIMARY KEY,
    balance NUMERIC(30,2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS public.transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    transaction_type TEXT NOT NULL,
    amount NUMERIC(20,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    network TEXT,
    tx_hash TEXT,
    payout_tx_hash TEXT,
    destination_address TEXT,
    admin_note TEXT,
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS public.game_rounds (
    id BIGSERIAL PRIMARY KEY,
    round_code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    starts_at TIMESTAMPTZ NOT NULL,
    betting_closes_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    result_number INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ
  )`,
  `ALTER TABLE public.game_rounds ADD COLUMN IF NOT EXISTS predicted_result INT`,
  `ALTER TABLE public.game_rounds ADD COLUMN IF NOT EXISTS settlement_key UUID`,
  `ALTER TABLE public.game_rounds ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
  `CREATE TABLE IF NOT EXISTS public.bets (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL,
    bet_type TEXT NOT NULL,
    selection SMALLINT,
    stake NUMERIC(20,2) NOT NULL,
    fee NUMERIC(20,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    payout NUMERIC(20,2) NOT NULL DEFAULT 0,
    result_number INT,
    request_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ
  )`,
  `ALTER TABLE public.bets ADD COLUMN IF NOT EXISTS fee NUMERIC(20,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE public.bets ADD COLUMN IF NOT EXISTS payout NUMERIC(20,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE public.bets ADD COLUMN IF NOT EXISTS result_number INT`,
  `ALTER TABLE public.bets ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ`,
  `ALTER TABLE public.bets ADD COLUMN IF NOT EXISTS request_id UUID`,
  `CREATE INDEX IF NOT EXISTS idx_bets_round_status ON public.bets (round_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_bets_user_id ON public.bets (user_id, id DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_bets_user_request ON public.bets (user_id, request_id) WHERE request_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS public.referral_commissions (
    id BIGSERIAL PRIMARY KEY,
    bet_id BIGINT,
    referrer_user_id BIGINT NOT NULL,
    source_user_id BIGINT NOT NULL,
    referral_level INT NOT NULL,
    fee_amount NUMERIC(20,2) NOT NULL DEFAULT 0,
    commission_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
    commission_amount NUMERIC(20,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS public.referral_rewards (
    id BIGSERIAL PRIMARY KEY,
    referrer_user_id BIGINT NOT NULL,
    referred_user_id BIGINT NOT NULL,
    reward_points NUMERIC(20,2) NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    credited_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS public.prediction_history (
    id BIGSERIAL PRIMARY KEY, round_code TEXT NOT NULL, predicted_number INT,
    predicted_colour TEXT, actual_number INT, actual_colour TEXT,
    result TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
  )`
];

const PLACE_BET_SQL = `
CREATE OR REPLACE FUNCTION public.place_bet_atomic(
  p_user_id    bigint,
  p_round_code text,
  p_bet_type   text,
  p_selection  smallint,
  p_stake      numeric,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  c_fee_rate CONSTANT numeric := 0.02;
  c_min_stake CONSTANT numeric := 10;
  v_round     public.game_rounds%ROWTYPE;
  v_dup       public.bets%ROWTYPE;
  v_balance   numeric;
  v_fee       numeric;
  v_bet_id    bigint;
  v_new_bal   numeric;
  v_upline    bigint;
  v_child     bigint;
  v_level     int;
  v_rate      numeric;
  v_comm      numeric;
BEGIN
  IF p_user_id IS NULL OR p_round_code IS NULL OR p_request_id IS NULL OR p_stake IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid bet request.');
  END IF;

  IF p_bet_type NOT IN ('Number','Red','Green','Violet','Big','Small') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid bet type.');
  END IF;

  IF (p_bet_type = 'Number' AND (p_selection IS NULL OR p_selection < 0 OR p_selection > 9))
     OR (p_bet_type <> 'Number' AND p_selection IS NOT NULL) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid selection.');
  END IF;

  IF p_stake < c_min_stake OR p_stake <> round(p_stake, 2) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Stake must be at least 10 points, with maximum 2 decimals.');
  END IF;

  -- Idempotency: the same request id returns the bet that was already placed.
  SELECT * INTO v_dup FROM public.bets
   WHERE user_id = p_user_id AND request_id::text = p_request_id::text
   LIMIT 1;
  IF FOUND THEN
    SELECT balance INTO v_new_bal FROM public.wallet_balances WHERE user_id = p_user_id;
    RETURN jsonb_build_object(
      'success', true, 'duplicate', true, 'message', 'Bet accepted.',
      'bet_id', v_dup.id, 'round_code', p_round_code, 'bet_type', v_dup.bet_type,
      'selection', v_dup.selection, 'stake', v_dup.stake, 'fee', v_dup.fee,
      'trade_amount', v_dup.stake - v_dup.fee, 'balance', COALESCE(v_new_bal, 0));
  END IF;

  SELECT * INTO v_round FROM public.game_rounds WHERE round_code = p_round_code FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Round not found.');
  END IF;

  IF v_round.result_number IS NOT NULL OR v_round.settled_at IS NOT NULL
     OR v_round.status = 'settled'
     OR v_round.betting_closes_at <= NOW()
     OR v_round.ends_at <= NOW() THEN
    RETURN jsonb_build_object('success', false, 'message', 'Betting is closed for this round.');
  END IF;

  IF v_round.starts_at > NOW() + INTERVAL '10 minutes' THEN
    RETURN jsonb_build_object('success', false, 'message', 'This round is not open for betting yet.');
  END IF;

  -- Lock the wallet row so two bets can never spend the same points.
  SELECT balance INTO v_balance FROM public.wallet_balances WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_balance < p_stake THEN
    RETURN jsonb_build_object('success', false, 'message', 'Insufficient wallet balance.');
  END IF;

  v_fee := round(p_stake * c_fee_rate, 2);

  UPDATE public.wallet_balances
     SET balance = balance - p_stake, updated_at = NOW()
   WHERE user_id = p_user_id
   RETURNING balance INTO v_new_bal;

  INSERT INTO public.bets (user_id, round_id, bet_type, selection, stake, fee, status, payout, request_id, created_at)
  VALUES (p_user_id, v_round.id, p_bet_type, p_selection, p_stake, v_fee, 'pending', 0, p_request_id, NOW())
  RETURNING id INTO v_bet_id;

  INSERT INTO public.transactions (user_id, transaction_type, amount, status, created_at, updated_at)
  VALUES (p_user_id, 'bet', p_stake, 'completed', NOW(), NOW());

  -- Referral commission on the fee (3 levels). Never blocks the bet itself.
  BEGIN
    v_child := p_user_id;
    FOR v_level IN 1..3 LOOP
      SELECT NULLIF(u.referred_by::text, '')::bigint INTO v_upline
        FROM public.users u WHERE u.id = v_child;
      EXIT WHEN v_upline IS NULL OR v_upline = p_user_id;
      v_rate := CASE v_level WHEN 1 THEN 0.15 WHEN 2 THEN 0.10 ELSE 0.05 END;
      v_comm := round(v_fee * v_rate, 2);
      IF v_comm > 0 THEN
        INSERT INTO public.referral_commissions
          (bet_id, referrer_user_id, source_user_id, referral_level, fee_amount, commission_rate, commission_amount, created_at)
        VALUES (v_bet_id, v_upline, p_user_id, v_level, v_fee, v_rate, v_comm, NOW());
      END IF;
      v_child := v_upline;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'place_bet_atomic: referral commission skipped: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'success', true, 'message', 'Bet accepted.',
    'bet_id', v_bet_id, 'round_code', p_round_code, 'bet_type', p_bet_type,
    'selection', p_selection, 'stake', p_stake, 'fee', v_fee,
    'trade_amount', p_stake - v_fee, 'balance', v_new_bal);

EXCEPTION WHEN unique_violation THEN
  -- Two identical requests raced each other; the other one won.
  RETURN jsonb_build_object('success', false, 'message', 'Duplicate request. Please refresh and check your bets.');
END;
$fn$`;

const SETTLE_SQL = `
CREATE OR REPLACE FUNCTION public.settle_expired_round()
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  c_number CONSTANT numeric := 9;
  c_colour CONSTANT numeric := 2;
  c_violet CONSTANT numeric := 4.5;
  v_round   public.game_rounds%ROWTYPE;
  v_result  int;
  v_colour  text;
  v_size    text;
  v_settled int := 0;
  v_winners int := 0;
  v_total   numeric := 0;
BEGIN
  -- Oldest ended-but-unsettled round. SKIP LOCKED: a parallel call takes the next one.
  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE status IN ('open','locked')
     AND ends_at <= NOW()
     AND result_number IS NULL
     AND settled_at IS NULL
   ORDER BY ends_at ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Admin "next result" (predicted_result) wins, otherwise a random digit 0-9.
  v_result := COALESCE(
    v_round.predicted_result,
    (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 10)::int
  );
  IF v_result < 0 OR v_result > 9 THEN
    v_result := (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 10)::int;
  END IF;

  v_colour := CASE WHEN v_result IN (0,5) THEN 'Violet'
                   WHEN v_result IN (1,3,7,9) THEN 'Green' ELSE 'Red' END;
  v_size   := CASE WHEN v_result >= 5 THEN 'Big' ELSE 'Small' END;

  UPDATE public.game_rounds
     SET result_number = v_result, status = 'settled', settled_at = NOW(),
         updated_at = NOW(), settlement_key = gen_random_uuid()
   WHERE id = v_round.id;

  -- One statement: settle the round's pending bets, credit winners, write the ledger.
  WITH calc AS (
    SELECT b.id,
           round((b.stake - COALESCE(b.fee, 0)) * (CASE b.bet_type
             WHEN 'Number' THEN CASE WHEN b.selection::text = v_result::text THEN c_number ELSE 0 END
             WHEN 'Red'    THEN CASE WHEN v_result = 0 THEN 0.5 WHEN v_result IN (2,4,6,8) THEN c_colour ELSE 0 END
             WHEN 'Green'  THEN CASE WHEN v_result = 5 THEN 0.5 WHEN v_result IN (1,3,7,9) THEN c_colour ELSE 0 END
             WHEN 'Violet' THEN CASE WHEN v_result IN (0,5) THEN c_violet ELSE 0 END
             WHEN 'Big'    THEN CASE WHEN v_result >= 5 THEN c_colour ELSE 0 END
             WHEN 'Small'  THEN CASE WHEN v_result < 5 THEN c_colour ELSE 0 END
             ELSE 0 END), 2) AS pay
      FROM public.bets b
     WHERE b.round_id = v_round.id AND b.status = 'pending'
  ), upd AS (
    UPDATE public.bets b
       SET result_number = v_result,
           status  = CASE WHEN c.pay > 0 THEN 'won' ELSE 'lost' END,
           payout  = c.pay,
           settled_at = NOW()
      FROM calc c
     WHERE b.id = c.id
    RETURNING b.id, b.user_id, b.payout, b.status
  ), wal AS (
    UPDATE public.wallet_balances w
       SET balance = w.balance + s.total, updated_at = NOW()
      FROM (SELECT user_id, SUM(payout) AS total FROM upd WHERE status = 'won' GROUP BY user_id) s
     WHERE w.user_id = s.user_id
    RETURNING w.user_id
  ), ledger AS (
    INSERT INTO public.transactions (user_id, transaction_type, amount, status, created_at, updated_at)
    SELECT user_id, 'payout', payout, 'completed', NOW(), NOW()
      FROM upd WHERE status = 'won'
    RETURNING id
  )
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE status = 'won'),
         COALESCE(SUM(payout) FILTER (WHERE status = 'won'), 0)
    INTO v_settled, v_winners, v_total
    FROM upd;

  RETURN jsonb_build_object(
    'phase', 'result_calculated',
    'round_code', v_round.round_code,
    'result_number', v_result,
    'result_color', v_colour,
    'result_size', v_size,
    'settled_bets', v_settled,
    'winners', v_winners,
    'total_payout', v_total);
END;
$fn$`;

const FUNCTION_STATEMENTS = [PLACE_BET_SQL.trim(), SETTLE_SQL.trim()];

// Everything in one list, in run order (used to generate the .sql migration file).
const ALL_STATEMENTS = [...TABLE_STATEMENTS, ...FUNCTION_STATEMENTS];

let _ready = false;
let _pending = null;

async function missing(client) {
  const r = await client.query(
    `SELECT to_regprocedure($1) IS NULL AS no_bet,
            to_regprocedure($2) IS NULL AS no_settle`,
    [BET_SIGNATURE, SETTLE_SIGNATURE]
  );
  return { bet: r.rows[0].no_bet, settle: r.rows[0].no_settle };
}

async function run(client, inTransaction) {
  const need = await missing(client);
  if (!need.bet && !need.settle) return false;

  const sp = "sp_game_functions";
  if (inTransaction) await client.query(`SAVEPOINT ${sp}`);
  else await client.query("BEGIN");

  try {
    // One instance at a time; others wait, then find everything already created.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [LOCK_KEY]);

    const again = await missing(client);
    if (again.bet || again.settle) {
      for (const sql of TABLE_STATEMENTS) await client.query(sql);
      if (again.bet) await client.query(FUNCTION_STATEMENTS[0]);
      if (again.settle) await client.query(FUNCTION_STATEMENTS[1]);
    }

    if (inTransaction) await client.query(`RELEASE SAVEPOINT ${sp}`);
    else await client.query("COMMIT");
    return true;
  } catch (err) {
    if (inTransaction) await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
    else await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/**
 * Creates the game tables/functions when they are missing.
 * @param client         a pg client
 * @param opts.inTransaction  true when the caller already did BEGIN (uses a SAVEPOINT)
 * Never throws: a failure is logged and retried on the next call.
 * Returns true when something was created.
 */
async function ensureGameFunctions(client, opts = {}) {
  if (_ready) return false;
  if (_pending) return _pending;

  _pending = (async () => {
    try {
      const created = await run(client, Boolean(opts.inTransaction));
      _ready = true;
      if (created) console.log("[game-functions] created missing place_bet_atomic / settle_expired_round");
      return created;
    } catch (err) {
      console.error("[game-functions] setup failed:", err.message);
      return false;
    } finally {
      _pending = null;
    }
  })();

  return _pending;
}

module.exports = {
  ensureGameFunctions,
  ALL_STATEMENTS,
  BET_SIGNATURE,
  SETTLE_SIGNATURE
};
