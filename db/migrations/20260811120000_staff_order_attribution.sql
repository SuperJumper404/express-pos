-- migrate:up
ALTER TABLE `orders`
  ADD COLUMN `taken_by_user_id` INT(11) NULL AFTER `operator`,
  ADD COLUMN `taken_by_name` VARCHAR(255) NULL AFTER `taken_by_user_id`,
  ADD COLUMN `prepared_by_user_id` INT(11) NULL AFTER `taken_by_name`,
  ADD COLUMN `prepared_by_name` VARCHAR(255) NULL AFTER `prepared_by_user_id`,
  ADD INDEX `idx_orders_taken_by_user_id` (`taken_by_user_id`),
  ADD INDEX `idx_orders_prepared_by_user_id` (`prepared_by_user_id`);

ALTER TABLE `archives`
  ADD COLUMN `taken_by_user_id` INT(11) NULL AFTER `operator`,
  ADD COLUMN `taken_by_name` VARCHAR(255) NULL AFTER `taken_by_user_id`,
  ADD COLUMN `prepared_by_user_id` INT(11) NULL AFTER `taken_by_name`,
  ADD COLUMN `prepared_by_name` VARCHAR(255) NULL AFTER `prepared_by_user_id`;

-- migrate:down
ALTER TABLE `archives`
  DROP COLUMN `prepared_by_name`,
  DROP COLUMN `prepared_by_user_id`,
  DROP COLUMN `taken_by_name`,
  DROP COLUMN `taken_by_user_id`;

ALTER TABLE `orders`
  DROP INDEX `idx_orders_prepared_by_user_id`,
  DROP INDEX `idx_orders_taken_by_user_id`,
  DROP COLUMN `prepared_by_name`,
  DROP COLUMN `prepared_by_user_id`,
  DROP COLUMN `taken_by_name`,
  DROP COLUMN `taken_by_user_id`;
