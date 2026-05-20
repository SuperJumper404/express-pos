-- migrate:up

ALTER TABLE `shop`
  ADD COLUMN `stripe_account_id` varchar(191) DEFAULT NULL AFTER `smart_print_app`,
  ADD COLUMN `stripe_onboarding_complete` tinyint(1) NOT NULL DEFAULT '0' AFTER `stripe_account_id`,
  ADD COLUMN `stripe_charges_enabled` tinyint(1) NOT NULL DEFAULT '0' AFTER `stripe_onboarding_complete`,
  ADD COLUMN `stripe_payouts_enabled` tinyint(1) NOT NULL DEFAULT '0' AFTER `stripe_charges_enabled`;

ALTER TABLE `orders`
  ADD COLUMN `payment_status` varchar(32) NOT NULL DEFAULT 'unpaid' AFTER `payment`,
  ADD COLUMN `payment_provider` varchar(32) DEFAULT NULL AFTER `payment_status`,
  ADD COLUMN `stripe_payment_intent_id` varchar(191) DEFAULT NULL AFTER `payment_provider`;

CREATE TABLE `payments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `order_id` int(11) NOT NULL,
  `shop_id` int(11) NOT NULL,
  `stripe_payment_intent_id` varchar(191) NOT NULL,
  `stripe_charge_id` varchar(191) DEFAULT NULL,
  `amount` decimal(10,2) NOT NULL,
  `amount_cents` int(11) NOT NULL,
  `application_fee_amount` int(11) NOT NULL,
  `currency` varchar(8) NOT NULL DEFAULT 'eur',
  `status` varchar(32) NOT NULL,
  `payment_method` varchar(64) DEFAULT NULL,
  `refunded_at` datetime DEFAULT NULL,
  `created` datetime NOT NULL,
  `updated` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `stripe_payment_intent_id` (`stripe_payment_intent_id`),
  KEY `order_id` (`order_id`),
  KEY `shop_id` (`shop_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down

DROP TABLE IF EXISTS `payments`;

ALTER TABLE `orders`
  DROP COLUMN `stripe_payment_intent_id`,
  DROP COLUMN `payment_provider`,
  DROP COLUMN `payment_status`;

ALTER TABLE `shop`
  DROP COLUMN `stripe_payouts_enabled`,
  DROP COLUMN `stripe_charges_enabled`,
  DROP COLUMN `stripe_onboarding_complete`,
  DROP COLUMN `stripe_account_id`;
