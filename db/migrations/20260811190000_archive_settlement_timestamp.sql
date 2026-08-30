-- migrate:up

ALTER TABLE `archives`
  ADD COLUMN `archived_at` DATETIME(6) NULL AFTER `created`;

UPDATE `archives` SET `archived_at` = `created` WHERE `archived_at` IS NULL;

ALTER TABLE `archives`
  MODIFY COLUMN `archived_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  ADD KEY `idx_archives_shop_archived_at` (`shopid`, `archived_at`);

ALTER TABLE `archivesdetail`
  ADD KEY `idx_archivesdetail_orderid` (`orderid`);

ALTER TABLE `cash_closures`
  MODIFY COLUMN `opened_at` DATETIME(6) NULL,
  MODIFY COLUMN `closed_at` DATETIME(6) NOT NULL;

-- migrate:down

ALTER TABLE `cash_closures`
  MODIFY COLUMN `opened_at` DATETIME NULL,
  MODIFY COLUMN `closed_at` DATETIME NOT NULL;

ALTER TABLE `archivesdetail`
  DROP INDEX `idx_archivesdetail_orderid`;

ALTER TABLE `archives`
  DROP INDEX `idx_archives_shop_archived_at`,
  DROP COLUMN `archived_at`;
