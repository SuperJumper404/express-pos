-- migrate:up
CREATE TABLE `stock_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `shop_id` int NOT NULL,
  `item_type` enum('product','ingredient') NOT NULL,
  `product_id` int DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `unit` varchar(64) NOT NULL DEFAULT 'piece',
  `current_stock` int NOT NULL DEFAULT 0,
  `minimum_stock` int NOT NULL DEFAULT 0,
  `target_stock` int NOT NULL DEFAULT 0,
  `category_label` varchar(128) DEFAULT NULL,
  `reference` varchar(255) DEFAULT NULL,
  `default_supplier` varchar(255) DEFAULT NULL,
  `note` text DEFAULT NULL,
  `archived` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_stock_items_product` (`product_id`),
  KEY `idx_stock_items_shop_type` (`shop_id`,`item_type`,`archived`),
  KEY `idx_stock_items_status` (`shop_id`,`archived`,`current_stock`,`target_stock`)
);

CREATE TABLE `stock_movements` (
  `id` int NOT NULL AUTO_INCREMENT,
  `shop_id` int NOT NULL,
  `stock_item_id` int NOT NULL,
  `movement_type` enum('replenishment','inventory') NOT NULL,
  `quantity` int NOT NULL,
  `previous_stock` int NOT NULL,
  `new_stock` int NOT NULL,
  `supplier` varchar(255) DEFAULT NULL,
  `unit_price` decimal(10,2) DEFAULT NULL,
  `total_price` decimal(10,2) DEFAULT NULL,
  `remark` text DEFAULT NULL,
  `operator_id` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_stock_movements_item` (`stock_item_id`,`created_at`),
  KEY `idx_stock_movements_shop` (`shop_id`,`movement_type`,`created_at`)
);

CREATE TABLE `shopping_list_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `shop_id` int NOT NULL,
  `stock_item_id` int NOT NULL,
  `status_at_generation` enum('red','orange') NOT NULL,
  `current_stock_at_generation` int NOT NULL,
  `target_stock_at_generation` int NOT NULL,
  `quantity_to_buy` int NOT NULL,
  `estimated_unit_price` decimal(10,2) DEFAULT NULL,
  `estimated_total_price` decimal(10,2) DEFAULT NULL,
  `taken` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_shopping_list_shop` (`shop_id`,`taken`,`status_at_generation`),
  KEY `idx_shopping_list_item` (`stock_item_id`)
);

ALTER TABLE `products`
  ADD COLUMN `track_stock` tinyint(1) NOT NULL DEFAULT 1 AFTER `stock`,
  ADD COLUMN `stock_zero_behavior` enum('block','warn') NOT NULL DEFAULT 'block' AFTER `track_stock`,
  ADD COLUMN `stock_item_id` int DEFAULT NULL AFTER `stock_zero_behavior`;

INSERT INTO `stock_items` (
  `shop_id`, `item_type`, `product_id`, `name`, `unit`,
  `current_stock`, `minimum_stock`, `target_stock`, `created_at`, `updated_at`
)
SELECT
  `shopid`, 'product', `id`, `name`, 'piece',
  `stock`, 1, `stock`, `created`, COALESCE(`updated`, `created`)
FROM `products`;

UPDATE `products` p
JOIN `stock_items` si ON si.`product_id` = p.`id`
SET p.`track_stock` = 1,
    p.`stock_zero_behavior` = 'block',
    p.`stock_item_id` = si.`id`;

-- migrate:down
ALTER TABLE `products`
  DROP COLUMN `stock_item_id`,
  DROP COLUMN `stock_zero_behavior`,
  DROP COLUMN `track_stock`;

DROP TABLE IF EXISTS `shopping_list_items`;
DROP TABLE IF EXISTS `stock_movements`;
DROP TABLE IF EXISTS `stock_items`;
