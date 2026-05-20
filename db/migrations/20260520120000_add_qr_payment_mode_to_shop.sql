-- migrate:up

ALTER TABLE `shop`
  ADD COLUMN `qr_payment_mode` varchar(32) NOT NULL DEFAULT 'stripe_before_order' AFTER `smart_print_app`;

-- migrate:down

ALTER TABLE `shop`
  DROP COLUMN `qr_payment_mode`;
