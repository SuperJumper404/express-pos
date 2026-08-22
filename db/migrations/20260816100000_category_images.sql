-- migrate:up

ALTER TABLE `category`
  ADD COLUMN `image` varchar(255) DEFAULT NULL AFTER `name`;

-- migrate:down

ALTER TABLE `category`
  DROP COLUMN `image`;
