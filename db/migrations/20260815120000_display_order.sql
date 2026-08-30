-- migrate:up

ALTER TABLE `products`
  ADD COLUMN `sort_order` int NOT NULL DEFAULT 0 AFTER `is_hidden`;

ALTER TABLE `category`
  ADD COLUMN `sort_order` int NOT NULL DEFAULT 0 AFTER `shopid`;

UPDATE `products`
SET `sort_order` = `id` * 10
WHERE `sort_order` = 0;

UPDATE `category`
SET `sort_order` = `id` * 10
WHERE `sort_order` = 0;

-- migrate:down

ALTER TABLE `category`
  DROP COLUMN `sort_order`;

ALTER TABLE `products`
  DROP COLUMN `sort_order`;
