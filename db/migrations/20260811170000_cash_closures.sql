-- migrate:up

CREATE TABLE IF NOT EXISTS `cash_closures` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `shopid` INT NOT NULL,
  `closure_number` INT NOT NULL,
  `opened_at` DATETIME NULL,
  `closed_at` DATETIME NOT NULL,
  `closed_by_user_id` INT NULL,
  `orders_count` INT NOT NULL DEFAULT 0,
  `total_revenue` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `payments_summary` JSON NOT NULL,
  `vat_summary` JSON NOT NULL,
  `created` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_cash_closures_shop_number` (`shopid`, `closure_number`),
  KEY `idx_cash_closures_shop_closed_at` (`shopid`, `closed_at`)
);

-- migrate:down

DROP TABLE IF EXISTS `cash_closures`;
