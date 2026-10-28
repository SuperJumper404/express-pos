-- migrate:up
CREATE TABLE customer_accounts (
  id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
CREATE TABLE customer_account_identities (
  channel varchar(16) COLLATE utf8mb4_bin NOT NULL,
  destination varchar(254) COLLATE utf8mb4_bin NOT NULL,
  account_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  verified_at datetime NOT NULL,
  PRIMARY KEY(channel,destination),
  CONSTRAINT fk_global_identity_account FOREIGN KEY(account_id) REFERENCES customer_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE customers ADD COLUMN global_customer_id char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  ADD UNIQUE KEY uq_customer_global_shop (shopid,global_customer_id),
  ADD CONSTRAINT fk_customer_global FOREIGN KEY(global_customer_id) REFERENCES customer_accounts(id);
ALTER TABLE customer_identities DROP CHECK chk_customer_identity_channel,
  ADD CONSTRAINT chk_customer_identity_channel CHECK(channel IN ('email','whatsapp','sms'));
ALTER TABLE customer_otp_challenges DROP CHECK chk_customer_challenge_channel,
  ADD CONSTRAINT chk_customer_challenge_channel CHECK(channel IN ('email','whatsapp','sms'));

-- migrate:down
-- Remove SMS authentication rows before restoring the previous channel constraints.
DELETE s FROM customer_sessions s JOIN customer_otp_challenges c ON c.id=s.verified_challenge_id WHERE c.channel='sms';
DELETE FROM customer_otp_challenges WHERE channel='sms';
DELETE FROM customer_identities WHERE channel='sms';
ALTER TABLE customer_identities DROP CHECK chk_customer_identity_channel,
  ADD CONSTRAINT chk_customer_identity_channel CHECK(channel IN ('email','whatsapp'));
ALTER TABLE customer_otp_challenges DROP CHECK chk_customer_challenge_channel,
  ADD CONSTRAINT chk_customer_challenge_channel CHECK(channel IN ('email','whatsapp'));
ALTER TABLE customers DROP FOREIGN KEY fk_customer_global, DROP INDEX uq_customer_global_shop, DROP COLUMN global_customer_id;
DROP TABLE customer_account_identities;
DROP TABLE customer_accounts;
