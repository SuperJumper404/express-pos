-- migrate:up

ALTER TABLE `payments`
  ADD COLUMN `stripe_refund_id` varchar(191) DEFAULT NULL AFTER `stripe_charge_id`,
  ADD COLUMN `refund_status` varchar(32) DEFAULT NULL AFTER `status`,
  ADD COLUMN `refund_failure_reason` varchar(191) DEFAULT NULL AFTER `refund_status`;

UPDATE `payments`
SET `stripe_refund_id` = `stripe_charge_id`,
    `stripe_charge_id` = NULL
WHERE `status` = 'refunded'
  AND `refunded_at` IS NOT NULL
  AND `stripe_charge_id` LIKE 're_%'
  AND LEFT(`stripe_charge_id`, 3) = 're_';

UPDATE `payments`
SET `refund_status` = 'legacy_unknown'
WHERE `status` = 'refunded'
  AND `refunded_at` IS NOT NULL;

ALTER TABLE `payments`
  ADD UNIQUE KEY `stripe_refund_id` (`stripe_refund_id`);

-- migrate:down

ALTER TABLE `payments`
  DROP INDEX `stripe_refund_id`;

UPDATE `payments`
SET `stripe_charge_id` = `stripe_refund_id`
WHERE `stripe_charge_id` IS NULL
  AND `stripe_refund_id` LIKE 're_%'
  AND LEFT(`stripe_refund_id`, 3) = 're_';

ALTER TABLE `payments`
  DROP COLUMN `refund_failure_reason`,
  DROP COLUMN `refund_status`,
  DROP COLUMN `stripe_refund_id`;
