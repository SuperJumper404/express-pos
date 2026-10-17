-- migrate:up

CREATE TABLE customers (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  name varchar(255) NOT NULL DEFAULT '',
  contact_phone varchar(255) NOT NULL DEFAULT '',
  contact_email varchar(254) NOT NULL DEFAULT '',
  next_address_number int unsigned NOT NULL DEFAULT 1,
  default_address_id bigint unsigned DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_owner (shopid, id),
  KEY idx_customer_phone (shopid, contact_phone),
  CONSTRAINT fk_customer_shop FOREIGN KEY (shopid) REFERENCES shop (id),
  CONSTRAINT chk_customer_address_counter CHECK (next_address_number > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_identities (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  customer_id bigint unsigned NOT NULL,
  channel varchar(16) COLLATE utf8mb4_bin NOT NULL,
  destination varchar(254) COLLATE utf8mb4_bin NOT NULL,
  verified_at datetime NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_identity_destination (shopid, channel, destination),
  KEY idx_customer_identity_owner (shopid, customer_id),
  CONSTRAINT fk_customer_identity_owner FOREIGN KEY (shopid, customer_id) REFERENCES customers (shopid, id),
  CONSTRAINT chk_customer_identity_channel CHECK (channel IN ('email','whatsapp')),
  CONSTRAINT chk_customer_identity_destination CHECK (CHAR_LENGTH(destination) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_addresses (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  customer_id bigint unsigned NOT NULL,
  label_number int unsigned NOT NULL,
  address_snapshot json NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_address_owner (shopid, customer_id, id),
  UNIQUE KEY uq_customer_address_label (shopid, customer_id, label_number),
  CONSTRAINT fk_customer_address_owner FOREIGN KEY (shopid, customer_id) REFERENCES customers (shopid, id),
  CONSTRAINT chk_customer_address_label CHECK (label_number > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE customers ADD CONSTRAINT fk_customer_default_address
  FOREIGN KEY (shopid, id, default_address_id) REFERENCES customer_addresses (shopid, customer_id, id);

CREATE TABLE customer_otp_challenges (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  customer_id bigint unsigned DEFAULT NULL,
  purpose varchar(16) COLLATE utf8mb4_bin NOT NULL,
  channel varchar(16) COLLATE utf8mb4_bin NOT NULL,
  destination varchar(254) COLLATE utf8mb4_bin NOT NULL,
  code_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  browser_binding_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempts int unsigned NOT NULL DEFAULT 0,
  send_status varchar(16) COLLATE utf8mb4_bin NOT NULL DEFAULT 'pending',
  sent_at datetime DEFAULT NULL,
  expires_at datetime NOT NULL,
  invalidated_at datetime DEFAULT NULL,
  verified_at datetime DEFAULT NULL,
  consumed_at datetime DEFAULT NULL,
  verified_customer_id bigint unsigned DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_challenge_verified_owner (shopid, verified_customer_id, id),
  KEY idx_customer_challenge_destination (shopid, channel, destination, created_at),
  KEY idx_customer_challenge_expiry (expires_at),
  CONSTRAINT fk_customer_challenge_shop FOREIGN KEY (shopid) REFERENCES shop (id),
  CONSTRAINT fk_customer_challenge_owner FOREIGN KEY (shopid, customer_id) REFERENCES customers (shopid, id),
  CONSTRAINT fk_customer_challenge_verified_owner FOREIGN KEY (shopid, verified_customer_id) REFERENCES customers (shopid, id),
  CONSTRAINT chk_customer_challenge_purpose CHECK (purpose IN ('login','link') AND (purpose <> 'link' OR customer_id IS NOT NULL)),
  CONSTRAINT chk_customer_challenge_channel CHECK (channel IN ('email','whatsapp')),
  CONSTRAINT chk_customer_challenge_attempts CHECK (attempts <= 5),
  CONSTRAINT chk_customer_challenge_send CHECK (send_status IN ('pending','sent','failed')),
  CONSTRAINT chk_customer_challenge_verified CHECK (
    (verified_at IS NULL AND verified_customer_id IS NULL) OR
    (verified_at IS NOT NULL AND verified_customer_id IS NOT NULL AND consumed_at IS NOT NULL AND send_status = 'sent'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_sessions (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  customer_id bigint unsigned NOT NULL,
  verified_challenge_id bigint unsigned NOT NULL,
  token_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  csrf_secret_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at datetime NOT NULL,
  revoked_at datetime DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_session_token (token_hash),
  UNIQUE KEY uq_customer_session_challenge (verified_challenge_id),
  KEY idx_customer_session_owner (shopid, customer_id),
  KEY idx_customer_session_expiry (expires_at),
  CONSTRAINT fk_customer_session_owner FOREIGN KEY (shopid, customer_id) REFERENCES customers (shopid, id),
  CONSTRAINT fk_customer_session_challenge FOREIGN KEY (shopid, customer_id, verified_challenge_id)
    REFERENCES customer_otp_challenges (shopid, verified_customer_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Task10 uses the existing shared UNIQUE (shopid,scope,subject_hash,window_start)
-- in service_rate_limits for customer_otp_contact/ip/verify/resend. No quota rows
-- or unverified identities are inferred from staff contacts or historical orders.
ALTER TABLE orders ADD CONSTRAINT fk_orders_customer_account
  FOREIGN KEY (shopid, customer_account_id) REFERENCES customers (shopid, id);
ALTER TABLE archives ADD CONSTRAINT fk_archives_customer_account
  FOREIGN KEY (shopid, customer_account_id) REFERENCES customers (shopid, id);
ALTER TABLE deliveries ADD CONSTRAINT fk_deliveries_customer_account
  FOREIGN KEY (shopid, customer_account_id) REFERENCES customers (shopid, id);

-- migrate:down

ALTER TABLE deliveries DROP FOREIGN KEY fk_deliveries_customer_account;
ALTER TABLE archives DROP FOREIGN KEY fk_archives_customer_account;
ALTER TABLE orders DROP FOREIGN KEY fk_orders_customer_account;
-- These nullable Task1 links outlive the tables being rolled back.
UPDATE deliveries SET customer_account_id = NULL WHERE customer_account_id IS NOT NULL;
UPDATE archives SET customer_account_id = NULL WHERE customer_account_id IS NOT NULL;
UPDATE orders SET customer_account_id = NULL WHERE customer_account_id IS NOT NULL;
DROP TABLE customer_sessions;
DROP TABLE customer_otp_challenges;
DROP TABLE customer_identities;
ALTER TABLE customers DROP FOREIGN KEY fk_customer_default_address;
DROP TABLE customer_addresses;
DROP TABLE customers;
