-- migrate:up

CREATE TABLE `customization_steps` (
  `id` int NOT NULL AUTO_INCREMENT,
  `shop_id` int NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` varchar(512) DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `created` datetime NOT NULL,
  `updated` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_customization_steps_shop_active` (`shop_id`,`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `customization_step_choices` (
  `id` int NOT NULL AUTO_INCREMENT,
  `step_id` int NOT NULL,
  `choice_type` enum('simple','linked_product') NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `image` varchar(255) DEFAULT NULL,
  `linked_product_id` int DEFAULT NULL,
  `default_extra_price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `default_position` int NOT NULL DEFAULT 0,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `created` datetime NOT NULL,
  `updated` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_customization_choices_step_active` (`step_id`,`active`),
  KEY `idx_customization_choices_linked_product` (`linked_product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `product_customization_steps` (
  `id` int NOT NULL AUTO_INCREMENT,
  `product_id` int NOT NULL,
  `step_id` int NOT NULL,
  `position` int NOT NULL DEFAULT 0,
  `minimum_choices` int NOT NULL DEFAULT 0,
  `maximum_choices` int NOT NULL DEFAULT 1,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `created` datetime NOT NULL,
  `updated` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_product_customization_step` (`product_id`,`step_id`),
  KEY `idx_product_customization_steps_order` (`product_id`,`active`,`position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `product_customization_step_choices` (
  `id` int NOT NULL AUTO_INCREMENT,
  `product_customization_step_id` int NOT NULL,
  `step_choice_id` int NOT NULL,
  `extra_price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `position` int NOT NULL DEFAULT 0,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_product_step_choice` (`product_customization_step_id`,`step_choice_id`),
  KEY `idx_product_step_choices_order` (`product_customization_step_id`,`active`,`position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `orderdetail_customization_snapshots` (
  `id` int NOT NULL AUTO_INCREMENT,
  `orderdetail_id` int NOT NULL,
  `product_customization_step_id` int DEFAULT NULL,
  `product_customization_step_choice_id` int DEFAULT NULL,
  `step_name` varchar(255) NOT NULL,
  `step_position` int NOT NULL,
  `choice_type` enum('simple','linked_product') NOT NULL,
  `choice_name` varchar(255) NOT NULL,
  `choice_position` int NOT NULL,
  `unit_extra_price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `linked_product_id` int DEFAULT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_orderdetail_customization_snapshots` (`orderdetail_id`,`step_position`,`choice_position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `archivesdetail_customization_snapshots` (
  `id` int NOT NULL AUTO_INCREMENT,
  `archivesdetail_id` int NOT NULL,
  `product_customization_step_id` int DEFAULT NULL,
  `product_customization_step_choice_id` int DEFAULT NULL,
  `step_name` varchar(255) NOT NULL,
  `step_position` int NOT NULL,
  `choice_type` enum('simple','linked_product') NOT NULL,
  `choice_name` varchar(255) NOT NULL,
  `choice_position` int NOT NULL,
  `unit_extra_price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `linked_product_id` int DEFAULT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_archivesdetail_customization_snapshots` (`archivesdetail_id`,`step_position`,`choice_position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `order_stock_reservations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `product_id` int NOT NULL,
  `quantity` int NOT NULL,
  `status` enum('reserved','committed','released') NOT NULL,
  `expires_at` datetime DEFAULT NULL,
  `created` datetime NOT NULL,
  `updated` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_order_stock_reservation` (`order_id`,`product_id`),
  KEY `idx_order_stock_reservations_expiry` (`status`,`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `orders`
  ADD COLUMN `client_order_token` varchar(64) DEFAULT NULL,
  ADD COLUMN `client_order_payload_hash` varchar(64) DEFAULT NULL,
  ADD UNIQUE KEY `uq_orders_shop_client_token` (`shopid`,`client_order_token`);

INSERT INTO customization_steps (
  id,
  shop_id,
  name,
  description,
  active,
  created,
  updated
)
SELECT
  pc.id,
  p.shopid,
  COALESCE(pc.name, ''),
  pc.description,
  1,
  NOW(),
  NULL
FROM product_customization pc
JOIN products p ON p.id = pc.product_id;

INSERT INTO product_customization_steps (
  id,
  product_id,
  step_id,
  position,
  minimum_choices,
  maximum_choices,
  active,
  created,
  updated
)
SELECT
  pc.id,
  pc.product_id,
  pc.id,
  pc.id,
  CASE WHEN pc.mandatory <> 0 THEN 1 ELSE 0 END,
  CASE
    WHEN pc.limit_choice IS NOT NULL AND pc.limit_choice > 0
      THEN pc.limit_choice
    ELSE GREATEST(COALESCE(choice_counts.choice_count, 0), 1)
  END,
  1,
  NOW(),
  NULL
FROM product_customization pc
LEFT JOIN (
  SELECT
    product_customization_id,
    COUNT(*) AS choice_count
  FROM product_choice
  GROUP BY product_customization_id
) choice_counts ON choice_counts.product_customization_id = pc.id;

INSERT INTO customization_step_choices (
  id,
  step_id,
  choice_type,
  name,
  image,
  linked_product_id,
  default_extra_price,
  default_position,
  active,
  created,
  updated
)
SELECT
  pc.id,
  pc.product_customization_id,
  'simple',
  pc.name,
  NULL,
  NULL,
  COALESCE(pc.price, 0.00),
  pc.id,
  1,
  NOW(),
  NULL
FROM product_choice pc;

INSERT INTO product_customization_step_choices (
  id,
  product_customization_step_id,
  step_choice_id,
  extra_price,
  position,
  active
)
SELECT
  pc.id,
  pc.product_customization_id,
  pc.id,
  COALESCE(pc.price, 0.00),
  pc.id,
  1
FROM product_choice pc;

INSERT INTO orderdetail_customization_snapshots (
  orderdetail_id,
  product_customization_step_id,
  product_customization_step_choice_id,
  step_name,
  step_position,
  choice_type,
  choice_name,
  choice_position,
  unit_extra_price,
  linked_product_id,
  created
)
SELECT
  oc.order_details_id,
  pcs.id,
  pcsc.id,
  cs.name,
  pcs.position,
  csc.choice_type,
  COALESCE(csc.name, ''),
  pcsc.position,
  pcsc.extra_price,
  csc.linked_product_id,
  o.created
FROM orders_customization oc
JOIN orders o ON o.id = oc.order_id
JOIN orderdetail od
  ON od.id = oc.order_details_id
  AND od.orderid = oc.order_id
  AND od.productid = oc.product_id
JOIN product_choice pc ON pc.id = oc.product_choice_id
JOIN product_customization_steps pcs
  ON pcs.id = pc.product_customization_id
  AND pcs.product_id = oc.product_id
JOIN customization_steps cs ON cs.id = pcs.step_id
JOIN product_customization_step_choices pcsc
  ON pcsc.id = pc.id
  AND pcsc.product_customization_step_id = pcs.id
JOIN customization_step_choices csc
  ON csc.id = pcsc.step_choice_id
  AND csc.step_id = cs.id;

-- Legacy archive rows do not retain a deterministic link to their original
-- order detail selections, so no archive snapshot rows are synthesized.

-- migrate:down

ALTER TABLE `orders`
  DROP INDEX `uq_orders_shop_client_token`,
  DROP COLUMN `client_order_payload_hash`,
  DROP COLUMN `client_order_token`;

DROP TABLE IF EXISTS `order_stock_reservations`;
DROP TABLE IF EXISTS `archivesdetail_customization_snapshots`;
DROP TABLE IF EXISTS `orderdetail_customization_snapshots`;
DROP TABLE IF EXISTS `product_customization_step_choices`;
DROP TABLE IF EXISTS `product_customization_steps`;
DROP TABLE IF EXISTS `customization_step_choices`;
DROP TABLE IF EXISTS `customization_steps`;
