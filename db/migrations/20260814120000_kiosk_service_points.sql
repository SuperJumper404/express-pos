-- migrate:up

ALTER TABLE `service_points`
  MODIFY COLUMN `type` enum('counter', 'click_collect', 'table', 'kiosk') NOT NULL;

ALTER TABLE `users`
  ADD COLUMN `service_point_id` INT(11) NULL,
  ADD KEY `idx_users_service_point` (`service_point_id`);

-- migrate:down

ALTER TABLE `users`
  DROP KEY `idx_users_service_point`,
  DROP COLUMN `service_point_id`;

ALTER TABLE `service_points`
  MODIFY COLUMN `type` enum('counter', 'click_collect', 'table') NOT NULL;
