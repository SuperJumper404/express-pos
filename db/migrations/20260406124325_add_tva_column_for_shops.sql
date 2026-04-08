-- migrate:up

ALTER TABLE `shop` ADD COLUMN `activate_tva` INT(11) NOT NULL DEFAULT '0' AFTER `shop_siret`;
-- migrate:down

ALTER TABLE `shop` DROP COLUMN `activate_tva`;