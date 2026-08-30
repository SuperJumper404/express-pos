-- migrate:up
ALTER TABLE `shop`
  ADD COLUMN `shop_naf` VARCHAR(255) NULL AFTER `shop_siret`,
  ADD COLUMN `shop_vat_number` VARCHAR(255) NULL AFTER `shop_naf`,
  ADD COLUMN `receipt_review_qr_url` VARCHAR(255) NULL AFTER `shop_vat_number`,
  ADD COLUMN `receipt_review_qr_label` VARCHAR(255) NULL AFTER `receipt_review_qr_url`,
  ADD COLUMN `cash_register_number` VARCHAR(64) NULL AFTER `receipt_review_qr_label`;

-- migrate:down
ALTER TABLE `shop`
  DROP COLUMN `receipt_review_qr_label`,
  DROP COLUMN `receipt_review_qr_url`,
  DROP COLUMN `shop_vat_number`,
  DROP COLUMN `shop_naf`,
  DROP COLUMN `cash_register_number`;
