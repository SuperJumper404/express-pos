-- migrate:up
ALTER TABLE users ADD COLUMN staff_pin_encrypted VARCHAR(255) NULL;

-- migrate:down
ALTER TABLE users DROP COLUMN staff_pin_encrypted;
