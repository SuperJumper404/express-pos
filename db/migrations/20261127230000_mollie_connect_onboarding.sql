-- migrate:up
CREATE TABLE mollie_oauth_attempts (
  shopid int(11) NOT NULL,
  staff_id int(11) NOT NULL,
  state_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at datetime NOT NULL,
  state_used tinyint(1) NOT NULL DEFAULT 0,
  organization_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  organization_name varchar(255) DEFAULT NULL,
  encrypted_tokens text DEFAULT NULL,
  PRIMARY KEY (shopid),
  UNIQUE KEY uq_mollie_oauth_state (state_hash),
  CONSTRAINT fk_mollie_oauth_shop FOREIGN KEY (shopid) REFERENCES shop(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mollie_connections (
  shopid int(11) NOT NULL,
  organization_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  organization_name varchar(255) NOT NULL,
  encrypted_tokens text NOT NULL,
  connected_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (shopid),
  CONSTRAINT fk_mollie_connection_shop FOREIGN KEY (shopid) REFERENCES shop(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE mollie_connections;
DROP TABLE mollie_oauth_attempts;
