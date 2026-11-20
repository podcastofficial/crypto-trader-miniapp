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
