-- migrate:up
ALTER TABLE `products`
  ADD COLUMN `is_hidden` TINYINT(1) NOT NULL DEFAULT 0 AFTER `archived`;

-- migrate:down
ALTER TABLE `products`
  DROP COLUMN `is_hidden`;
