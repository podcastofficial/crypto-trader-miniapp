ALTER TABLE public.users ADD COLUMN IF NOT EXISTS referral_code TEXT;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS referred_by BIGINT;

CREATE TABLE IF NOT EXISTS public.referral_rewards (
    id BIGSERIAL PRIMARY KEY,
    referrer_user_id BIGINT NOT NULL,
    referred_user_id BIGINT NOT NULL,
    reward_points NUMERIC(20,2) NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    credited_at TIMESTAMPTZ
  );

ALTER TABLE public.referral_rewards ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_rewards_referred ON public.referral_rewards (referred_user_id);

CREATE OR REPLACE FUNCTION public.apply_referral_code(p_user_id bigint, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_code      text := upper(btrim(coalesce(p_code, '')));
  v_me        record;
  v_referrer  bigint;
  v_cursor    bigint;
  v_hops      int := 0;
BEGIN
  IF v_code = '' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Enter a valid referral code.');
  END IF;

  SELECT id, NULLIF(referred_by::text, '')::bigint AS referred_by, referral_code
    INTO v_me
    FROM public.users WHERE id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'User not found.');
  END IF;

  IF v_me.referred_by IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'A referral code is already applied to your account.');
  END IF;

  SELECT id INTO v_referrer
    FROM public.users WHERE upper(referral_code) = v_code LIMIT 1;

  IF v_referrer IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Referral code not found.');
  END IF;

  IF v_referrer = p_user_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'You cannot use your own referral code.');
  END IF;

  -- No loops: the referrer must not already be below this user.
  v_cursor := v_referrer;
  WHILE v_cursor IS NOT NULL AND v_hops < 10 LOOP
    IF v_cursor = p_user_id THEN
      RETURN jsonb_build_object('success', false, 'message', 'This referral code cannot be used.');
    END IF;
    SELECT NULLIF(referred_by::text, '')::bigint INTO v_cursor
      FROM public.users WHERE id = v_cursor;
    v_hops := v_hops + 1;
  END LOOP;

  UPDATE public.users SET referred_by = v_referrer WHERE id = p_user_id;

  INSERT INTO public.referral_rewards (referrer_user_id, referred_user_id, reward_points, status, created_at)
  VALUES (v_referrer, p_user_id, 100, 'pending', NOW())
  ON CONFLICT (referred_user_id) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'message', 'Referral applied successfully.', 'referrer_id', v_referrer);
END;
$fn$;
