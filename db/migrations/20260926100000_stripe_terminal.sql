-- migrate:up

CREATE TABLE `stripe_terminal_locations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `shopid` int NOT NULL,
  `stripe_location_id` varchar(191) NOT NULL,
  `display_name` varchar(255) NOT NULL,
  `address_line1` varchar(255) NOT NULL,
  `postal_code` varchar(32) NOT NULL,
  `city` varchar(128) NOT NULL,
  `country` char(2) NOT NULL DEFAULT 'FR',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_terminal_location_shop` (`shopid`),
  UNIQUE KEY `uq_terminal_location_stripe` (`stripe_location_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `stripe_terminal_readers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `shopid` int NOT NULL,
  `terminal_location_id` int NOT NULL,
  `stripe_reader_id` varchar(191) NOT NULL,
  `serial_number` varchar(191) DEFAULT NULL,
  `device_type` varchar(64) DEFAULT NULL,
  `label` varchar(255) NOT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'offline',
  `assigned_user_id` int DEFAULT NULL,
  `assigned_service_point_id` int DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `active_assigned_user_id` int GENERATED ALWAYS AS
    (CASE WHEN `is_active` = 1 THEN `assigned_user_id` ELSE NULL END) STORED,
  `active_assigned_service_point_id` int GENERATED ALWAYS AS
    (CASE WHEN `is_active` = 1 THEN `assigned_service_point_id` ELSE NULL END) STORED,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_terminal_reader_stripe` (`stripe_reader_id`),
  UNIQUE KEY `uq_terminal_reader_active_user` (`active_assigned_user_id`),
  UNIQUE KEY `uq_terminal_reader_active_service_point` (`active_assigned_service_point_id`),
  KEY `idx_terminal_reader_shop_user` (`shopid`,`assigned_user_id`),
  KEY `idx_terminal_reader_shop_location` (`shopid`,`terminal_location_id`),
  CONSTRAINT `chk_terminal_reader_assignment`
    CHECK (`assigned_user_id` IS NULL OR `assigned_service_point_id` IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `stripe_terminal_payments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `shopid` int NOT NULL,
  `terminal_reader_id` int NOT NULL,
  `cashier_user_id` int NOT NULL,
  `stripe_payment_intent_id` varchar(191) DEFAULT NULL,
  `stripe_charge_id` varchar(191) DEFAULT NULL,
  `idempotency_key` varchar(191) NOT NULL,
  `stripe_connected_account_id` varchar(191) NOT NULL,
  `amount_cents` int NOT NULL,
  `application_fee_amount` int NOT NULL,
  `currency` varchar(8) NOT NULL DEFAULT 'eur',
  `discount_type` varchar(32) DEFAULT NULL,
  `discount_value` decimal(10,2) DEFAULT NULL,
  `status` enum('creating','processing','succeeded','failed','canceled') NOT NULL DEFAULT 'creating',
  `failure_code` varchar(64) DEFAULT NULL,
  `failure_message` varchar(255) DEFAULT NULL,
  `active_reader_id` int GENERATED ALWAYS AS
    (CASE WHEN `status` IN ('creating','processing') THEN `terminal_reader_id` ELSE NULL END) STORED,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_terminal_payment_intent` (`stripe_payment_intent_id`),
  UNIQUE KEY `uq_terminal_payment_idempotency` (`idempotency_key`),
  UNIQUE KEY `uq_terminal_payment_active_reader` (`active_reader_id`),
  KEY `idx_terminal_payment_shop_reader` (`shopid`,`terminal_reader_id`,`status`),
  KEY `idx_terminal_payment_shop_cashier` (`shopid`,`cashier_user_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `stripe_terminal_payment_orders` (
  `terminal_payment_id` int NOT NULL,
  `order_id` int NOT NULL,
  `shopid` int NOT NULL,
  `amount_cents` int NOT NULL,
  `refund_generation` int unsigned NOT NULL DEFAULT 0,
  `stripe_refund_id` varchar(191) DEFAULT NULL,
  `refund_status` varchar(32) DEFAULT NULL,
  UNIQUE KEY `uq_terminal_payment_order` (`terminal_payment_id`,`order_id`),
  UNIQUE KEY `uq_terminal_order_refund` (`stripe_refund_id`),
  KEY `idx_terminal_allocation_order` (`order_id`),
  KEY `idx_terminal_allocation_shop_payment` (`shopid`,`terminal_payment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `orders`
  ADD COLUMN `stripe_terminal_payment_id` int DEFAULT NULL AFTER `stripe_payment_intent_id`,
  ADD KEY `idx_orders_terminal_payment` (`stripe_terminal_payment_id`);

ALTER TABLE `archives`
  ADD COLUMN `stripe_terminal_payment_id` int DEFAULT NULL AFTER `stripe_payment_intent_id`,
  ADD KEY `idx_archives_terminal_payment` (`stripe_terminal_payment_id`);

-- migrate:down

ALTER TABLE `archives`
  DROP KEY `idx_archives_terminal_payment`,
  DROP COLUMN `stripe_terminal_payment_id`;

ALTER TABLE `orders`
  DROP KEY `idx_orders_terminal_payment`,
  DROP COLUMN `stripe_terminal_payment_id`;

DROP TABLE IF EXISTS `stripe_terminal_payment_orders`;
DROP TABLE IF EXISTS `stripe_terminal_payments`;
DROP TABLE IF EXISTS `stripe_terminal_readers`;
DROP TABLE IF EXISTS `stripe_terminal_locations`;
