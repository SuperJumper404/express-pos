-- migrate:up
ALTER TABLE delivery_charge_snapshots
  ADD COLUMN manual_fee_override TINYINT(1) NOT NULL DEFAULT 0,
  DROP CHECK chk_delivery_charge_policy,
  ADD CONSTRAINT chk_delivery_charge_policy_v2 CHECK (
    revision > 0 AND vat_rate IN (5.5, 10, 20)
    AND free_delivery_applied IN (0, 1) AND manual_fee_override IN (0, 1)
    AND (
      (manual_fee_override = 1 AND free_delivery_applied = 0)
      OR (manual_fee_override = 0 AND (
        (free_delivery_applied = 1 AND fee_cents = 0)
        OR (free_delivery_applied = 0 AND fee_cents = band_fee_cents)
      ))
    )
  );

-- migrate:down
-- MySQL rejects the rollback if it would invalidate existing charge snapshots.
ALTER TABLE delivery_charge_snapshots
  DROP CHECK chk_delivery_charge_policy_v2,
  DROP COLUMN manual_fee_override,
  ADD CONSTRAINT chk_delivery_charge_policy CHECK (
    revision > 0 AND vat_rate IN (5.5, 10, 20) AND free_delivery_applied IN (0, 1)
    AND (
      (free_delivery_applied = 1 AND fee_cents = 0)
      OR (free_delivery_applied = 0 AND fee_cents = band_fee_cents)
    )
  );
