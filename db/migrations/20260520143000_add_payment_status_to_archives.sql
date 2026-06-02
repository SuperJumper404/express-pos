-- migrate:up

ALTER TABLE `archives`
  ADD COLUMN `payment_status` varchar(32) NOT NULL DEFAULT 'unpaid' AFTER `payment`,
  ADD COLUMN `payment_provider` varchar(32) DEFAULT NULL AFTER `payment_status`,
  ADD COLUMN `stripe_payment_intent_id` varchar(191) DEFAULT NULL AFTER `payment_provider`;

-- migrate:down

ALTER TABLE `archives`
  DROP COLUMN `stripe_payment_intent_id`,
  DROP COLUMN `payment_provider`,
  DROP COLUMN `payment_status`;
