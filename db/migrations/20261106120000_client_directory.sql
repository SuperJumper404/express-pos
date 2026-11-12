-- migrate:up
CREATE TABLE customer_directory_contacts (
  shopid int(11) NOT NULL,
  contact_key char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  customer_id bigint unsigned NOT NULL,
  source_customer_id bigint unsigned DEFAULT NULL,
  match_kind varchar(24) NOT NULL,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (shopid, contact_key),
  KEY idx_directory_customer (shopid, customer_id),
  CONSTRAINT fk_directory_customer FOREIGN KEY (shopid, customer_id) REFERENCES customers(shopid, id),
  CONSTRAINT fk_directory_source FOREIGN KEY (shopid, source_customer_id) REFERENCES customers(shopid, id),
  CONSTRAINT chk_directory_match CHECK (match_kind IN ('import','verified_phone','manual'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_directory_events (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shopid int(11) NOT NULL,
  contact_key char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_customer_id bigint unsigned DEFAULT NULL,
  to_customer_id bigint unsigned NOT NULL,
  match_kind varchar(24) NOT NULL,
  actor_id int(11) DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_directory_event (shopid, contact_key, id),
  CONSTRAINT fk_directory_event_contact FOREIGN KEY (shopid, contact_key) REFERENCES customer_directory_contacts(shopid, contact_key),
  CONSTRAINT fk_directory_event_target FOREIGN KEY (shopid, to_customer_id) REFERENCES customers(shopid, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE customer_directory_events;
DROP TABLE customer_directory_contacts;
