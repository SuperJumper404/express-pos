-- migrate:up

CREATE TABLE `cash_register_settlements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shopid` INT(11) NOT NULL,
  `service_point_id` INT(11) DEFAULT NULL,
  `table_reference` VARCHAR(191) NOT NULL,
  `payment_method` VARCHAR(64) NOT NULL,
  `subtotal_before_discount` DECIMAL(10,2) NOT NULL,
  `discount_type` VARCHAR(16) NOT NULL,
  `discount_value` DECIMAL(10,2) NOT NULL,
  `discount_amount` DECIMAL(10,2) NOT NULL,
  `total_amount` DECIMAL(10,2) NOT NULL,
  `stripe_terminal_payment_id` INT DEFAULT NULL,
  `idempotency_key` VARCHAR(191) NOT NULL,
  `created_by_user_id` INT(11) DEFAULT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cash_register_settlements_shop_idempotency` (`shopid`, `idempotency_key`),
  KEY `idx_cash_register_settlements_shop_created_at` (`shopid`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `archives`
  ADD COLUMN `cash_register_settlement_id` BIGINT UNSIGNED NULL,
  ADD KEY `idx_archives_cash_register_settlement` (`cash_register_settlement_id`),
  ADD CONSTRAINT `fk_archives_cash_register_settlement`
    FOREIGN KEY (`cash_register_settlement_id`)
    REFERENCES `cash_register_settlements` (`id`);

-- migrate:down

ALTER TABLE `archives`
  DROP FOREIGN KEY `fk_archives_cash_register_settlement`,
  DROP KEY `idx_archives_cash_register_settlement`,
  DROP COLUMN `cash_register_settlement_id`;

DROP TABLE IF EXISTS `cash_register_settlements`;
