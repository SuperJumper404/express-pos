-- migrate:up
ALTER TABLE users
  ADD COLUMN staff_login_id VARCHAR(6) NULL,
  ADD COLUMN staff_pin_hash VARCHAR(255) NULL,
  ADD UNIQUE INDEX users_staff_login_id_unique (staff_login_id);

-- migrate:down
ALTER TABLE users
  DROP INDEX users_staff_login_id_unique,
  DROP COLUMN staff_pin_hash,
  DROP COLUMN staff_login_id;
