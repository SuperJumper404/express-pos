-- migrate:up

ALTER TABLE `stripe_terminal_payments`
  ADD COLUMN `card_receipt_details` LONGTEXT DEFAULT NULL AFTER `stripe_charge_id`;

-- migrate:down

ALTER TABLE `stripe_terminal_payments`
  DROP COLUMN `card_receipt_details`;
