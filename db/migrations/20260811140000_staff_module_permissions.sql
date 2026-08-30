-- migrate:up
ALTER TABLE users
  ADD COLUMN module_permissions TEXT NULL;

-- migrate:down
ALTER TABLE users
  DROP COLUMN module_permissions;
