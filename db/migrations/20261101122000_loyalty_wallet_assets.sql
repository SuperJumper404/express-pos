-- migrate:up
ALTER TABLE loyalty_programs ADD COLUMN wallet_asset_version char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL;
CREATE TABLE loyalty_wallet_assets (
  version char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  shopid int NOT NULL,
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_wallet_assets_shop (shopid)
) ENGINE=InnoDB;

-- migrate:down
DROP TABLE loyalty_wallet_assets;
ALTER TABLE loyalty_programs DROP COLUMN wallet_asset_version;
