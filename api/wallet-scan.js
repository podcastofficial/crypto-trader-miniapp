    if (action === "deposit_request") {
      if (!validAmount(body.amount)) {
        return response(res, 400, {
          success: false,
          message: "Enter an amount between 1 and 10000 USDT.",
        });
      }

      const baseAmount = Number(body.amount);

      await client.query("BEGIN");

      try {
        // Avoid creating multiple active deposit requests for the same user.
        const existing = await client.query(
          `SELECT id, amount, status, request_expires_at
           FROM public.real_wallet_ledger
           WHERE user_id = $1
             AND transaction_type = 'deposit'
             AND status = 'pending'
             AND request_expires_at > NOW()
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [userId]
        );

        if (existing.rowCount > 0) {
          await client.query("COMMIT");

          return response(res, 200, {
            success: true,
            message: "You already have an active deposit request.",
            deposit: existing.rows[0],
          });
        }

        // Generate an amount with 4 decimal places.
        // The scanner must match the exact amount on-chain.
        const suffix = crypto.randomInt(1, 9999) / 10000;
        const uniqueAmount = (baseAmount + suffix).toFixed(4);

        const depositAddress =
          process.env.USDT_BEP20_DEPOSIT_ADDRESS;

        if (!/^0x[a-fA-F0-9]{40}$/.test(depositAddress || "")) {
          await client.query("ROLLBACK");

          return response(res, 503, {
            success: false,
            message: "Deposit address is not configured correctly.",
          });
        }

        const result = await client.query(
          `INSERT INTO public.real_wallet_ledger
             (user_id, transaction_type, amount, status,
              network, destination_address, request_expires_at)
           VALUES
             ($1, 'deposit', $2, 'pending',
              'BEP20', $3, NOW() + INTERVAL '30 minutes')
           RETURNING id, amount, status, network,
                     destination_address, request_expires_at`,
          [userId, uniqueAmount, depositAddress]
        );

        await client.query("COMMIT");

        return response(res, 201, {
          success: true,
          message: "Deposit request created. Wait for blockchain verification before crediting.",
          deposit: result.rows[0],
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }