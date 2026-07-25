-- migrate:up
ALTER TABLE `orders`
  ADD COLUMN `is_takeaway` TINYINT(1) NOT NULL DEFAULT 0 AFTER `remark`;
ALTER TABLE `archives`
  ADD COLUMN `is_takeaway` TINYINT(1) NOT NULL DEFAULT 0 AFTER `remark`;

-- migrate:down
ALTER TABLE `archives` DROP COLUMN `is_takeaway`;
ALTER TABLE `orders` DROP COLUMN `is_takeaway`;
