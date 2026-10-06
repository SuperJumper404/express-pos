-- migrate:up

ALTER TABLE `service_points`
  ADD COLUMN `printer_ip` varchar(255) NOT NULL DEFAULT '' AFTER `kiosk_pin_hash`,
  ADD COLUMN `smart_print_app` tinyint(1) NOT NULL DEFAULT '0' AFTER `printer_ip`;

-- migrate:down

ALTER TABLE `service_points`
  DROP COLUMN `smart_print_app`,
  DROP COLUMN `printer_ip`;
