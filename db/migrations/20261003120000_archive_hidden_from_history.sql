-- migrate:up

ALTER TABLE `archives`
  ADD COLUMN `hidden_from_history` TINYINT(1) NOT NULL DEFAULT 0 AFTER `token`,
  ADD COLUMN `hidden_from_history_at` DATETIME NULL AFTER `hidden_from_history`,
  ADD COLUMN `hidden_from_history_by_user_id` INT NULL AFTER `hidden_from_history_at`,
  ADD KEY `idx_archives_shop_hidden_archived_at` (`shopid`, `hidden_from_history`, `archived_at`);

-- migrate:down

ALTER TABLE `archives`
  DROP KEY `idx_archives_shop_hidden_archived_at`,
  DROP COLUMN `hidden_from_history_by_user_id`,
  DROP COLUMN `hidden_from_history_at`,
  DROP COLUMN `hidden_from_history`;
