-- migrate:up

ALTER TABLE `shop`
  ADD COLUMN `kitchen_closed` tinyint(1) NOT NULL DEFAULT '0' AFTER `shop_status`;

-- migrate:down

ALTER TABLE `shop`
  DROP COLUMN `kitchen_closed`;
