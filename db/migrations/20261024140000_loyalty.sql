-- migrate:up
CREATE TABLE loyalty_programs (
  shopid int(11) NOT NULL,
  config json NOT NULL,
  version int unsigned NOT NULL DEFAULT 1,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (shopid),
  CONSTRAINT fk_loyalty_program_shop FOREIGN KEY (shopid) REFERENCES shop(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE loyalty_members (
  id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  shopid int(11) NOT NULL,
  customer_id bigint unsigned NOT NULL,
  qr char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  balance bigint NOT NULL DEFAULT 0,
  reserved bigint NOT NULL DEFAULT 0,
  revision bigint unsigned NOT NULL DEFAULT 1,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_loyalty_member_owner (shopid,id),
  UNIQUE KEY uq_loyalty_customer (shopid,customer_id),
  UNIQUE KEY uq_loyalty_qr (qr),
  CONSTRAINT fk_loyalty_member_customer FOREIGN KEY (shopid,customer_id) REFERENCES customers(shopid,id),
  CONSTRAINT chk_loyalty_balance CHECK (balance >= 0 AND reserved >= 0 AND reserved <= balance)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE loyalty_orders (
  shopid int(11) NOT NULL,
  order_id int(11) NOT NULL,
  member_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rule_snapshot json NOT NULL,
  reward_snapshot json DEFAULT NULL,
  points_cost bigint NOT NULL DEFAULT 0,
  discount_cents bigint NOT NULL DEFAULT 0,
  paid_cents bigint NOT NULL DEFAULT 0,
  refunded_cents bigint NOT NULL DEFAULT 0,
  restored_points bigint NOT NULL DEFAULT 0,
  status varchar(16) NOT NULL DEFAULT 'attached',
  reservation_expires_at datetime DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (shopid,order_id),
  KEY idx_loyalty_order_expiry (status,reservation_expires_at),
  CONSTRAINT fk_loyalty_order_member FOREIGN KEY (shopid,member_id) REFERENCES loyalty_members(shopid,id),
  CONSTRAINT chk_loyalty_order_status CHECK (status IN ('attached','reserved','paid','released')),
  CONSTRAINT chk_loyalty_order_amounts CHECK (points_cost >= 0 AND discount_cents >= 0 AND paid_cents >= 0 AND refunded_cents >= 0 AND refunded_cents <= paid_cents AND restored_points >= 0 AND restored_points <= points_cost)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE loyalty_ledger (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  member_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_id int(11) DEFAULT NULL,
  event_key varchar(190) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind varchar(24) NOT NULL,
  points bigint NOT NULL,
  reason varchar(1000) NOT NULL DEFAULT '',
  actor_id int(11) DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id),
  UNIQUE KEY uq_loyalty_event (shopid,event_key),
  KEY idx_loyalty_ledger_member (shopid,member_id,id),
  CONSTRAINT fk_loyalty_ledger_member FOREIGN KEY (shopid,member_id) REFERENCES loyalty_members(shopid,id),
  CONSTRAINT chk_loyalty_ledger_kind CHECK (kind IN ('earn','spend','restore','refund','release','reserve','adjustment','expire'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE loyalty_wallet_jobs (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  member_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision bigint unsigned NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempts int unsigned NOT NULL DEFAULT 0,
  next_attempt_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error varchar(128) DEFAULT NULL,
  locked_at datetime DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id),
  UNIQUE KEY uq_loyalty_wallet_revision (member_id,revision),
  KEY idx_loyalty_wallet_due (status,next_attempt_at),
  CONSTRAINT fk_loyalty_wallet_member FOREIGN KEY (shopid,member_id) REFERENCES loyalty_members(shopid,id),
  CONSTRAINT chk_loyalty_wallet_status CHECK (status IN ('pending','processing','done','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE loyalty_wallet_jobs;
DROP TABLE loyalty_ledger;
DROP TABLE loyalty_orders;
DROP TABLE loyalty_members;
DROP TABLE loyalty_programs;
