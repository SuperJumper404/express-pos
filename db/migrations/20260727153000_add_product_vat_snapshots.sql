-- migrate:up

ALTER TABLE `products`
  ADD COLUMN `vat_rate` DECIMAL(4,2) NOT NULL DEFAULT 10.00 AFTER `price`;

ALTER TABLE `orderdetail`
  ADD COLUMN `vat_rate` DECIMAL(4,2) NOT NULL DEFAULT 10.00 AFTER `total`,
  ADD COLUMN `unit_price_ht` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `vat_rate`,
  ADD COLUMN `unit_vat` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `unit_price_ht`,
  ADD COLUMN `total_ht` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `unit_vat`,
  ADD COLUMN `total_vat` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `total_ht`;

ALTER TABLE `archivesdetail`
  ADD COLUMN `vat_rate` DECIMAL(4,2) NOT NULL DEFAULT 10.00 AFTER `total`,
  ADD COLUMN `unit_price_ht` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `vat_rate`,
  ADD COLUMN `unit_vat` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `unit_price_ht`,
  ADD COLUMN `total_ht` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `unit_vat`,
  ADD COLUMN `total_vat` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `total_ht`;

UPDATE `orderdetail`
SET
  `vat_rate` = 10.00,
  `unit_price_ht` = ROUND(`price` / 1.10, 2),
  `unit_vat` = `price` - ROUND(`price` / 1.10, 2),
  `total_ht` = ROUND(`total` / 1.10, 2),
  `total_vat` = `total` - ROUND(`total` / 1.10, 2);

UPDATE `archivesdetail`
SET
  `vat_rate` = 10.00,
  `unit_price_ht` = ROUND(`price` / 1.10, 2),
  `unit_vat` = `price` - ROUND(`price` / 1.10, 2),
  `total_ht` = ROUND(`total` / 1.10, 2),
  `total_vat` = `total` - ROUND(`total` / 1.10, 2);

-- migrate:down

ALTER TABLE `archivesdetail`
  DROP COLUMN `total_vat`,
  DROP COLUMN `total_ht`,
  DROP COLUMN `unit_vat`,
  DROP COLUMN `unit_price_ht`,
  DROP COLUMN `vat_rate`;

ALTER TABLE `orderdetail`
  DROP COLUMN `total_vat`,
  DROP COLUMN `total_ht`,
  DROP COLUMN `unit_vat`,
  DROP COLUMN `unit_price_ht`,
  DROP COLUMN `vat_rate`;

ALTER TABLE `products`
  DROP COLUMN `vat_rate`;
