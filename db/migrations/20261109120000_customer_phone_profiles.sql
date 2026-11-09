-- migrate:up
ALTER TABLE orders
  ADD COLUMN customer_profile_id bigint unsigned DEFAULT NULL,
  ADD KEY idx_orders_customer_profile (shopid,customer_profile_id),
  ADD CONSTRAINT fk_orders_customer_profile FOREIGN KEY (shopid,customer_profile_id) REFERENCES customers(shopid,id);
ALTER TABLE archives
  ADD COLUMN customer_profile_id bigint unsigned DEFAULT NULL,
  ADD KEY idx_archives_customer_profile (shopid,customer_profile_id),
  ADD CONSTRAINT fk_archives_customer_profile FOREIGN KEY (shopid,customer_profile_id) REFERENCES customers(shopid,id);
ALTER TABLE customer_directory_contacts DROP CHECK chk_directory_match;
ALTER TABLE customer_directory_contacts ADD CONSTRAINT chk_directory_match CHECK (match_kind IN ('import','verified_phone','manual','phone'));

-- migrate:down
-- Preserve canonical mappings and contact rows when rolling back the enum extension.
UPDATE customer_directory_contacts SET match_kind='manual' WHERE match_kind='phone';
ALTER TABLE customer_directory_contacts DROP CHECK chk_directory_match;
ALTER TABLE customer_directory_contacts ADD CONSTRAINT chk_directory_match CHECK (match_kind IN ('import','verified_phone','manual'));
ALTER TABLE archives DROP FOREIGN KEY fk_archives_customer_profile, DROP INDEX idx_archives_customer_profile, DROP COLUMN customer_profile_id;
ALTER TABLE orders DROP FOREIGN KEY fk_orders_customer_profile, DROP INDEX idx_orders_customer_profile, DROP COLUMN customer_profile_id;
