-- migrate:up

ALTER TABLE `shop`
  ADD COLUMN `discount_percentages` TEXT NULL AFTER `shop_payment_methods`;

UPDATE `shop`
SET `discount_percentages` = '[5,10,15,20]'
WHERE `discount_percentages` IS NULL;

ALTER TABLE `orders`
  ADD COLUMN `subtotal_before_discount` DECIMAL(10,2) NULL AFTER `subtotal`,
  ADD COLUMN `discount_type` VARCHAR(16) NOT NULL DEFAULT 'none' AFTER `subtotal_before_discount`,
  ADD COLUMN `discount_value` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `discount_type`,
  ADD COLUMN `discount_amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `discount_value`;

ALTER TABLE `archives`
  ADD COLUMN `subtotal_before_discount` DECIMAL(10,2) NULL AFTER `subtotal`,
  ADD COLUMN `discount_type` VARCHAR(16) NOT NULL DEFAULT 'none' AFTER `subtotal_before_discount`,
  ADD COLUMN `discount_value` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `discount_type`,
  ADD COLUMN `discount_amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `discount_value`;

-- migrate:down

ALTER TABLE `archives`
  DROP COLUMN `discount_amount`,
  DROP COLUMN `discount_value`,
  DROP COLUMN `discount_type`,
  DROP COLUMN `subtotal_before_discount`;

ALTER TABLE `orders`
  DROP COLUMN `discount_amount`,
  DROP COLUMN `discount_value`,
  DROP COLUMN `discount_type`,
  DROP COLUMN `subtotal_before_discount`;

ALTER TABLE `shop`
  DROP COLUMN `discount_percentages`;
