-- migrate:up

ALTER TABLE `shop`
  ADD COLUMN `auto_print_order_tickets` tinyint(1) NOT NULL DEFAULT '0' AFTER `smart_print_app`;

-- migrate:down

ALTER TABLE `shop`
  DROP COLUMN `auto_print_order_tickets`;
