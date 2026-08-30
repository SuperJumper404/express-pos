-- migrate:up
ALTER TABLE `service_points`
  ADD COLUMN `kiosk_login_id` VARCHAR(6) NULL AFTER `public_access_version`,
  ADD COLUMN `kiosk_pin` VARCHAR(4) NULL AFTER `kiosk_login_id`,
  ADD COLUMN `kiosk_pin_hash` VARCHAR(255) NULL AFTER `kiosk_pin`,
  ADD UNIQUE INDEX `uq_service_points_kiosk_login_id` (`kiosk_login_id`);

-- migrate:down
ALTER TABLE `service_points`
  DROP INDEX `uq_service_points_kiosk_login_id`,
  DROP COLUMN `kiosk_pin_hash`,
  DROP COLUMN `kiosk_pin`,
  DROP COLUMN `kiosk_login_id`;
