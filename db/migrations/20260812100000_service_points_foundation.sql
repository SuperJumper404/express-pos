-- migrate:up

CREATE TABLE `service_points` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `shopid` int(11) NOT NULL,
  `name` varchar(255) NOT NULL,
  `type` enum('counter', 'click_collect', 'table', 'kiosk') NOT NULL,
  `system_key` varchar(32) DEFAULT NULL,
  `is_system` tinyint(1) NOT NULL DEFAULT '0',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int(11) NOT NULL DEFAULT '0',
  `public_access_version` int(11) NOT NULL DEFAULT '1',
  `legacy_user_id` int(11) DEFAULT NULL,
  `created` datetime NOT NULL,
  `updated` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_service_points_shop_system` (`shopid`, `system_key`),
  UNIQUE KEY `uq_service_points_legacy_user` (`legacy_user_id`),
  KEY `idx_service_points_shop_type_active_sort` (`shopid`, `type`, `is_active`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `orders`
  ADD COLUMN `service_point_id` INT(11) NULL,
  ADD COLUMN `order_source` VARCHAR(32) NOT NULL DEFAULT 'pos',
  ADD KEY `idx_orders_service_point` (`service_point_id`);

ALTER TABLE `archives`
  ADD COLUMN `service_point_id` INT(11) NULL,
  ADD COLUMN `order_source` VARCHAR(32) NOT NULL DEFAULT 'pos',
  ADD KEY `idx_archives_service_point` (`service_point_id`);

-- Every shop gets shared destinations before legacy rows are converted.
INSERT IGNORE INTO `service_points` (
  `shopid`, `name`, `type`, `system_key`, `is_system`, `is_active`,
  `sort_order`, `public_access_version`, `created`
)
SELECT `id`, 'Comptoir', 'counter', 'counter', 1, 1, 0, 1, NOW()
FROM `shop`;

INSERT IGNORE INTO `service_points` (
  `shopid`, `name`, `type`, `system_key`, `is_system`, `is_active`,
  `sort_order`, `public_access_version`, `created`
)
SELECT `id`, 'Click & Collect', 'click_collect', 'click_collect', 1, 1, 1, 1, NOW()
FROM `shop`;

-- Old access-2 users represented QR tables. Keep their id only for this transition.
INSERT INTO `service_points` (
  `shopid`, `name`, `type`, `is_system`, `is_active`, `sort_order`,
  `legacy_user_id`, `public_access_version`, `created`, `updated`
)
SELECT
  `shopid`, `username`, 'table', 0, `status` = 1, `id`, `id`, 1,
  COALESCE(NULLIF(CAST(`created` AS CHAR), '0000-00-00 00:00:00'), NOW()),
  NULLIF(CAST(`updated` AS CHAR), '0000-00-00 00:00:00')
FROM `users`
WHERE `access` = 2;

UPDATE `orders` AS `legacy_order`
LEFT JOIN `users` AS `legacy_user`
  ON `legacy_user`.`id` = `legacy_order`.`customerID`
  AND `legacy_user`.`shopid` = `legacy_order`.`shopid`
LEFT JOIN `service_points` AS `legacy_table`
  ON `legacy_table`.`legacy_user_id` = `legacy_order`.`customerID`
  AND `legacy_table`.`shopid` = `legacy_order`.`shopid`
LEFT JOIN `service_points` AS `click_collect`
  ON `click_collect`.`shopid` = `legacy_order`.`shopid`
  AND `click_collect`.`system_key` = 'click_collect'
LEFT JOIN `service_points` AS `counter`
  ON `counter`.`shopid` = `legacy_order`.`shopid`
  AND `counter`.`system_key` = 'counter'
SET
  `legacy_order`.`service_point_id` = CASE
    WHEN `legacy_table`.`id` IS NOT NULL THEN `legacy_table`.`id`
    WHEN `legacy_user`.`access` = 3 THEN `click_collect`.`id`
    ELSE `counter`.`id`
  END,
  `legacy_order`.`order_source` = CASE
    WHEN `legacy_table`.`id` IS NOT NULL THEN 'table_qr'
    WHEN `legacy_user`.`access` = 3 THEN 'web'
    ELSE 'pos'
  END
WHERE `legacy_order`.`service_point_id` IS NULL;

UPDATE `archives` AS `legacy_archive`
LEFT JOIN `users` AS `legacy_user`
  ON `legacy_user`.`id` = `legacy_archive`.`customerID`
  AND `legacy_user`.`shopid` = `legacy_archive`.`shopid`
LEFT JOIN `service_points` AS `legacy_table`
  ON `legacy_table`.`legacy_user_id` = `legacy_archive`.`customerID`
  AND `legacy_table`.`shopid` = `legacy_archive`.`shopid`
LEFT JOIN `service_points` AS `click_collect`
  ON `click_collect`.`shopid` = `legacy_archive`.`shopid`
  AND `click_collect`.`system_key` = 'click_collect'
LEFT JOIN `service_points` AS `counter`
  ON `counter`.`shopid` = `legacy_archive`.`shopid`
  AND `counter`.`system_key` = 'counter'
SET
  `legacy_archive`.`service_point_id` = CASE
    WHEN `legacy_table`.`id` IS NOT NULL THEN `legacy_table`.`id`
    WHEN `legacy_user`.`access` = 3 THEN `click_collect`.`id`
    ELSE `counter`.`id`
  END,
  `legacy_archive`.`order_source` = CASE
    WHEN `legacy_table`.`id` IS NOT NULL THEN 'table_qr'
    WHEN `legacy_user`.`access` = 3 THEN 'web'
    ELSE 'pos'
  END
WHERE `legacy_archive`.`service_point_id` IS NULL;

-- migrate:down

ALTER TABLE `archives`
  DROP KEY `idx_archives_service_point`,
  DROP COLUMN `order_source`,
  DROP COLUMN `service_point_id`;

ALTER TABLE `orders`
  DROP KEY `idx_orders_service_point`,
  DROP COLUMN `order_source`,
  DROP COLUMN `service_point_id`;

DROP TABLE IF EXISTS `service_points`;
