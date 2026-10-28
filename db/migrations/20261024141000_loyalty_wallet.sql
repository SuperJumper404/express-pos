-- migrate:up
CREATE TABLE loyalty_wallet_sequence (
  id tinyint unsigned NOT NULL PRIMARY KEY,
  revision bigint unsigned NOT NULL DEFAULT 0,
  CONSTRAINT chk_wallet_sequence_singleton CHECK (id=1)
) ENGINE=InnoDB;
INSERT INTO loyalty_wallet_sequence (id,revision) VALUES (1,0);

CREATE TABLE loyalty_wallet_passes (
  serial char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  shopid int(11) NOT NULL,
  member_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider varchar(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  auth_token char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_tag bigint unsigned NOT NULL DEFAULT 0,
  updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (serial),
  UNIQUE KEY uq_loyalty_wallet_owner (shopid, member_id, provider),
  CONSTRAINT fk_loyalty_wallet_pass_member FOREIGN KEY (shopid,member_id) REFERENCES loyalty_members (shopid,id),
  CONSTRAINT chk_loyalty_wallet_provider CHECK (provider IN ('apple','google'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE loyalty_wallet_registrations (
  serial char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  push_token varchar(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (serial,device_id),
  KEY idx_wallet_device (device_id),
  CONSTRAINT fk_wallet_registration_pass FOREIGN KEY (serial) REFERENCES loyalty_wallet_passes (serial) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE loyalty_wallet_jobs ADD COLUMN lease_token char(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL;

-- migrate:down
ALTER TABLE loyalty_wallet_jobs DROP COLUMN lease_token;
DROP TABLE loyalty_wallet_registrations;
DROP TABLE loyalty_wallet_passes;
DROP TABLE loyalty_wallet_sequence;
