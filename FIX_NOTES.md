# Fix: "place_bet_atomic does not exist" + cron 500

**Cause:** `public.place_bet_atomic(...)` and `public.settle_expired_round()` lived only inside the old database,
not in the repo. On this database they are missing, so every bet failed and `/api/cron` crashed while settling rounds.

**Fix**
- `lib/game-functions.js` – creates the missing tables (bets, referral_*, prediction_history ...) and both functions.
  Runs automatically once per server instance (from `api/game.js` and `api/cron.js`); it only creates what is missing.
- `db/migrations/001_game_functions.sql` – same SQL, if you want to run it manually in the Neon SQL editor.

**Rules implemented:** fee 2% of stake (taken together with the stake); payout = (stake - fee) x
Number 9 / Colour 2 / Violet 4.5 / Big-Small 2 (Red on 0 and Green on 5 pay 0.5x); referral commission on the fee L1 15% / L2 10% / L3 5%;
same `request_id` never places two bets; wallet row is locked so a balance can't be spent twice.
Result = admin "next result" (`game_rounds.predicted_result`) if set, otherwise random 0-9.

---

# Fix: referral link "could not be processed" + referral rewards

**Cause:** `public.apply_referral_code(...)` was not in the repo/database (same kind of problem as `place_bet_atomic`), so
`/start ref_CODE` always hit the error message. Also nothing ever created `referral_rewards` rows, and the claim check
looked for deposits with status `completed` while deposits are saved as `confirmed`.

**Fix**
- `lib/referral-functions.js` – creates `apply_referral_code()` (+ `users.referred_by`, `referral_rewards`) once per instance.
  Called from `api/telegram.js` (before applying a referral) and `api/game.js` (schema init).
  Manual alternative: run `db/migrations/002_referral_functions.sql` in the Neon SQL editor.
- Applying a code sets `users.referred_by` and creates a pending 100-point `referral_rewards` row.
- Reward is claimable once the referred user has a confirmed deposit >= 1 USDT (status `confirmed` or `completed`; the
  "bet in last 7 days" condition was removed).
- Trade commission (L1 15% / L2 10% / L3 5% of the fee) already runs in `place_bet_atomic` via `users.referred_by`.
