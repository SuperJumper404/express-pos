-- migrate:up
ALTER TABLE loyalty_members ADD COLUMN card_number char(16) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  ADD UNIQUE KEY uq_loyalty_card_number (shopid,card_number);
CREATE TABLE loyalty_lookup_limits (
  shopid int NOT NULL,
  actor_key char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  window_start datetime(3) NOT NULL,
  attempts int unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (shopid,actor_key)
) ENGINE=InnoDB;

-- migrate:down
DROP TABLE loyalty_lookup_limits;
ALTER TABLE loyalty_members DROP INDEX uq_loyalty_card_number, DROP COLUMN card_number;
