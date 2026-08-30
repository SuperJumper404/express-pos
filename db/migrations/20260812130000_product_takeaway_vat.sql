-- migrate:up

ALTER TABLE `products`
  ADD COLUMN `vat_rate_dine_in` DECIMAL(4,2) NOT NULL DEFAULT 10.00 AFTER `vat_rate`,
  ADD COLUMN `vat_rate_takeaway` DECIMAL(4,2) NOT NULL DEFAULT 10.00 AFTER `vat_rate_dine_in`;

UPDATE `products`
SET
  `vat_rate_dine_in` = `vat_rate`,
  `vat_rate_takeaway` = `vat_rate`;

-- migrate:down

ALTER TABLE `products`
  DROP COLUMN `vat_rate_takeaway`,
  DROP COLUMN `vat_rate_dine_in`;
