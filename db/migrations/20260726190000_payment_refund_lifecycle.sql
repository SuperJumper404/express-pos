-- migrate:up

ALTER TABLE `payments`
  ADD COLUMN `stripe_refund_id` varchar(191) DEFAULT NULL AFTER `stripe_charge_id`,
  ADD COLUMN `refund_status` varchar(32) DEFAULT NULL AFTER `status`,
  ADD COLUMN `refund_failure_reason` varchar(191) DEFAULT NULL AFTER `refund_status`,
  ADD UNIQUE KEY `stripe_refund_id` (`stripe_refund_id`);

UPDATE `payments`
SET `refund_status` = 'succeeded'
WHERE `status` = 'refunded'
  AND `refunded_at` IS NOT NULL
  AND `refund_status` IS NULL;

-- migrate:down

ALTER TABLE `payments`
  DROP INDEX `stripe_refund_id`,
  DROP COLUMN `refund_failure_reason`,
  DROP COLUMN `refund_status`,
  DROP COLUMN `stripe_refund_id`;
