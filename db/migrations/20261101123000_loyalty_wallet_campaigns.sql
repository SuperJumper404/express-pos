-- migrate:up
ALTER TABLE loyalty_members
  ADD COLUMN wallet_message_campaign_id bigint unsigned DEFAULT NULL,
  ADD COLUMN wallet_message varchar(200) NOT NULL DEFAULT '';
CREATE TABLE loyalty_wallet_campaigns (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shopid int NOT NULL,
  request_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  message varchar(200) NOT NULL,
  target_member_id char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  actor_id int NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  recipient_count int unsigned NOT NULL DEFAULT 0,
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at datetime(3) DEFAULT NULL,
  UNIQUE KEY uq_loyalty_campaign_request (shopid,request_id),
  KEY idx_loyalty_campaign_shop (shopid,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE loyalty_wallet_campaign_recipients (
  campaign_id bigint unsigned NOT NULL,
  shopid int NOT NULL,
  member_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  consent_version int unsigned NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  attempts int unsigned NOT NULL DEFAULT 0,
  next_attempt_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_at datetime(3) DEFAULT NULL,
  lease_token char(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  last_error varchar(64) DEFAULT NULL,
  PRIMARY KEY (campaign_id,member_id),
  KEY idx_loyalty_campaign_ready (status,next_attempt_at),
  CONSTRAINT fk_loyalty_campaign_recipient FOREIGN KEY (campaign_id) REFERENCES loyalty_wallet_campaigns(id) ON DELETE CASCADE,
  CONSTRAINT fk_loyalty_campaign_member FOREIGN KEY (shopid,member_id) REFERENCES loyalty_members(shopid,id)
) ENGINE=InnoDB;

-- migrate:down
DROP TABLE loyalty_wallet_campaign_recipients;
DROP TABLE loyalty_wallet_campaigns;
ALTER TABLE loyalty_members DROP COLUMN wallet_message, DROP COLUMN wallet_message_campaign_id;
