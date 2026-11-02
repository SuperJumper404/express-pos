-- migrate:up
ALTER TABLE loyalty_members
  ADD COLUMN phone_e164 varchar(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  ADD UNIQUE KEY uq_loyalty_phone (shopid,phone_e164);

-- migrate:down
ALTER TABLE loyalty_members DROP INDEX uq_loyalty_phone, DROP COLUMN phone_e164;
