-- migrate:up
ALTER TABLE `shop`
  ADD COLUMN `stripe_commission_percent` decimal(5,2) NOT NULL DEFAULT 5.00 AFTER `stripe_payouts_enabled`;

-- migrate:down
ALTER TABLE `shop`
  DROP COLUMN `stripe_commission_percent`;
