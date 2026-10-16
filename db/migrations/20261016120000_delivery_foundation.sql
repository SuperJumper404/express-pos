-- migrate:up

-- Legacy identifiers remain signed INTs. Composite keys enforce tenant ownership.
ALTER TABLE shop ADD UNIQUE KEY uq_delivery_shop_id (id);
ALTER TABLE users
  ADD COLUMN courier_available tinyint(1) NULL DEFAULT 0,
  ADD UNIQUE KEY uq_delivery_users_shop_id (shopid, id);
ALTER TABLE payments ADD UNIQUE KEY uq_delivery_payments_shop_id (shop_id, id);

CREATE TABLE shop_delivery_settings (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  revision int unsigned NOT NULL DEFAULT 1,
  enabled tinyint(1) NOT NULL DEFAULT 0,
  origin_latitude decimal(10,7) DEFAULT NULL,
  origin_longitude decimal(10,7) DEFAULT NULL,
  max_distance_meters int unsigned NOT NULL DEFAULT 0,
  minimum_items_cents bigint NOT NULL DEFAULT 0,
  free_delivery_enabled tinyint(1) NOT NULL DEFAULT 0,
  free_delivery_threshold_cents bigint DEFAULT NULL,
  fiscal_mode varchar(32) NOT NULL DEFAULT 'configured_rate',
  vat_rate decimal(4,2) DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_settings_shop (shopid),
  CONSTRAINT fk_delivery_settings_shop FOREIGN KEY (shopid) REFERENCES shop (id),
  CONSTRAINT chk_delivery_settings_revision CHECK (revision > 0),
  CONSTRAINT chk_delivery_settings_money CHECK (
    minimum_items_cents BETWEEN 0 AND 9007199254740991 AND
    (free_delivery_threshold_cents IS NULL OR free_delivery_threshold_cents BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT chk_delivery_settings_origin CHECK (
    (origin_latitude IS NULL AND origin_longitude IS NULL) OR
    (origin_latitude IS NOT NULL AND origin_longitude IS NOT NULL AND
      origin_latitude BETWEEN -90 AND 90 AND origin_longitude BETWEEN -180 AND 180)),
  CONSTRAINT chk_delivery_settings_fiscal CHECK (fiscal_mode = 'configured_rate' AND (vat_rate IS NULL OR vat_rate IN (5.5, 10, 20))),
  CONSTRAINT chk_delivery_settings_flags CHECK (enabled IN (0,1) AND free_delivery_enabled IN (0,1)),
  CONSTRAINT chk_delivery_settings_free CHECK (free_delivery_enabled = 0 OR free_delivery_threshold_cents IS NOT NULL),
  CONSTRAINT chk_delivery_settings_activation CHECK (
    enabled = 0 OR (origin_latitude IS NOT NULL AND origin_longitude IS NOT NULL AND max_distance_meters > 0 AND vat_rate IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO shop_delivery_settings (shopid) SELECT id FROM shop;

CREATE TABLE shop_delivery_fee_bands (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  up_to_meters int unsigned NOT NULL,
  fee_cents bigint NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_band_distance (shopid, up_to_meters),
  CONSTRAINT fk_delivery_band_settings FOREIGN KEY (shopid) REFERENCES shop_delivery_settings (shopid),
  CONSTRAINT chk_delivery_band_distance CHECK (up_to_meters > 0),
  CONSTRAINT chk_delivery_band_money CHECK (fee_cents BETWEEN 0 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE deliveries (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  origin_order_id int(10) NOT NULL,
  order_reference varchar(255) NOT NULL,
  customer_account_id bigint unsigned DEFAULT NULL,
  delivery_status enum('unassigned','assigned','in_transit','issue','delivered','failed','canceled') NOT NULL DEFAULT 'unassigned',
  version int unsigned NOT NULL DEFAULT 1,
  courier_id int(11) DEFAULT NULL,
  address_snapshot json NOT NULL,
  contact_snapshot json NOT NULL,
  latitude decimal(10,7) NOT NULL,
  longitude decimal(10,7) NOT NULL,
  distance_meters int unsigned NOT NULL,
  settings_revision int unsigned NOT NULL,
  charge_revision int unsigned NOT NULL DEFAULT 1,
  preparation_status int(2) NOT NULL DEFAULT 1,
  payment_status varchar(32) NOT NULL DEFAULT 'unpaid',
  client_order_token varchar(64) COLLATE utf8mb4_bin NOT NULL,
  confirmation_secret_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tracking_token_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tracking_expires_at datetime NOT NULL,
  closed_at datetime DEFAULT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_deliveries_shop_id (shopid, id),
  UNIQUE KEY uq_deliveries_origin_order (shopid, origin_order_id),
  UNIQUE KEY uq_deliveries_checkout (shopid, client_order_token),
  UNIQUE KEY uq_deliveries_tracking (tracking_token_hash),
  KEY idx_deliveries_dispatch (shopid, delivery_status, created_at),
  KEY idx_deliveries_courier (shopid, courier_id, delivery_status),
  KEY idx_deliveries_customer (shopid, customer_account_id, created_at),
  CONSTRAINT fk_deliveries_shop FOREIGN KEY (shopid) REFERENCES shop (id),
  CONSTRAINT fk_deliveries_courier FOREIGN KEY (shopid, courier_id) REFERENCES users (shopid, id),
  CONSTRAINT chk_deliveries_versions CHECK (version > 0 AND settings_revision > 0 AND charge_revision > 0),
  CONSTRAINT chk_deliveries_coordinates CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE orders
  ADD COLUMN delivery_id bigint unsigned DEFAULT NULL,
  ADD COLUMN customer_account_id bigint unsigned DEFAULT NULL,
  ADD COLUMN fulfillment_type enum('dine_in','takeaway','delivery') DEFAULT NULL,
  ADD UNIQUE KEY uq_orders_delivery (delivery_id),
  ADD KEY idx_orders_shop_delivery (shopid, delivery_id),
  ADD KEY idx_orders_customer_account (shopid, customer_account_id),
  ADD CONSTRAINT fk_orders_delivery FOREIGN KEY (shopid, delivery_id) REFERENCES deliveries (shopid, id);

ALTER TABLE archives
  ADD COLUMN delivery_id bigint unsigned DEFAULT NULL,
  ADD COLUMN customer_account_id bigint unsigned DEFAULT NULL,
  ADD COLUMN fulfillment_type enum('dine_in','takeaway','delivery') DEFAULT NULL,
  ADD UNIQUE KEY uq_archives_delivery (delivery_id),
  ADD KEY idx_archives_shop_delivery (shopid, delivery_id),
  ADD KEY idx_archives_customer_account (shopid, customer_account_id),
  ADD CONSTRAINT fk_archives_delivery FOREIGN KEY (shopid, delivery_id) REFERENCES deliveries (shopid, id);

UPDATE orders SET fulfillment_type = CASE WHEN is_takeaway = 1 THEN 'takeaway' ELSE 'dine_in' END;
UPDATE archives SET fulfillment_type = CASE WHEN is_takeaway = 1 THEN 'takeaway' ELSE 'dine_in' END;

CREATE TABLE delivery_charge_snapshots (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  delivery_id bigint unsigned NOT NULL,
  revision int unsigned NOT NULL,
  band_fee_cents bigint NOT NULL,
  free_delivery_applied tinyint(1) NOT NULL,
  fee_cents bigint NOT NULL,
  total_excl_tax_cents bigint NOT NULL,
  tax_cents bigint NOT NULL,
  vat_rate decimal(4,2) NOT NULL,
  fiscal_policy json NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_charge_revision (shopid, delivery_id, revision),
  CONSTRAINT fk_delivery_charge_delivery FOREIGN KEY (shopid, delivery_id) REFERENCES deliveries (shopid, id),
  CONSTRAINT chk_delivery_charge_money CHECK (
    band_fee_cents BETWEEN 0 AND 9007199254740991 AND fee_cents BETWEEN 0 AND 9007199254740991 AND
    total_excl_tax_cents BETWEEN 0 AND 9007199254740991 AND tax_cents BETWEEN 0 AND 9007199254740991 AND
    fee_cents = total_excl_tax_cents + tax_cents),
  CONSTRAINT chk_delivery_charge_policy CHECK (revision > 0 AND vat_rate IN (5.5,10,20) AND free_delivery_applied IN (0,1) AND
    ((free_delivery_applied = 1 AND fee_cents = 0) OR (free_delivery_applied = 0 AND fee_cents = band_fee_cents)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE delivery_events (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  delivery_id bigint unsigned NOT NULL,
  version int unsigned NOT NULL,
  event_type varchar(64) NOT NULL,
  actor_subject enum('staff','service_point','customer') NOT NULL,
  actor_id varchar(64) DEFAULT NULL,
  previous_state json NOT NULL,
  next_state json NOT NULL,
  reason text DEFAULT NULL,
  idempotency_key varchar(191) COLLATE utf8mb4_bin NOT NULL,
  request_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result json NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_event_idempotency (shopid, idempotency_key),
  UNIQUE KEY uq_delivery_event_version (shopid, delivery_id, version),
  KEY idx_delivery_events_journal (shopid, delivery_id, created_at, id),
  CONSTRAINT fk_delivery_event_delivery FOREIGN KEY (shopid, delivery_id) REFERENCES deliveries (shopid, id),
  CONSTRAINT chk_delivery_event_version CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE delivery_payment_collections (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  delivery_id bigint unsigned NOT NULL,
  courier_id int(11) NOT NULL,
  payment_id int(11) NOT NULL,
  method enum('cash','external_card') NOT NULL,
  amount_cents bigint NOT NULL,
  idempotency_key varchar(191) COLLATE utf8mb4_bin NOT NULL,
  request_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result json NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_collection_owner (shopid, courier_id, id),
  UNIQUE KEY uq_delivery_collection_idempotency (shopid, idempotency_key),
  UNIQUE KEY uq_delivery_collection_payment (shopid, payment_id),
  KEY idx_delivery_collection_delivery (shopid, delivery_id, created_at),
  CONSTRAINT fk_delivery_collection_delivery FOREIGN KEY (shopid, delivery_id) REFERENCES deliveries (shopid, id),
  CONSTRAINT fk_delivery_collection_courier FOREIGN KEY (shopid, courier_id) REFERENCES users (shopid, id),
  CONSTRAINT fk_delivery_collection_payment FOREIGN KEY (shopid, payment_id) REFERENCES payments (shop_id, id),
  CONSTRAINT chk_delivery_collection_money CHECK (amount_cents BETWEEN 1 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE courier_cash_remittances (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  courier_id int(11) NOT NULL,
  cashier_id int(11) NOT NULL,
  expected_cents bigint NOT NULL,
  received_cents bigint NOT NULL,
  discrepancy_cents bigint NOT NULL,
  expected_balance_version int unsigned NOT NULL,
  idempotency_key varchar(191) COLLATE utf8mb4_bin NOT NULL,
  request_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result json NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_courier_remittance_owner (shopid, courier_id, id),
  UNIQUE KEY uq_courier_remittance_idempotency (shopid, idempotency_key),
  KEY idx_courier_remittance_date (shopid, courier_id, created_at),
  CONSTRAINT fk_courier_remittance_courier FOREIGN KEY (shopid, courier_id) REFERENCES users (shopid, id),
  CONSTRAINT fk_courier_remittance_cashier FOREIGN KEY (shopid, cashier_id) REFERENCES users (shopid, id),
  CONSTRAINT chk_courier_remittance_money CHECK (
    expected_cents BETWEEN 0 AND 9007199254740991 AND received_cents BETWEEN 0 AND 9007199254740991 AND
    discrepancy_cents = received_cents - expected_cents AND expected_balance_version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE courier_cash_remittance_allocations (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  courier_id int(11) NOT NULL,
  remittance_id bigint unsigned NOT NULL,
  collection_id bigint unsigned NOT NULL,
  amount_cents bigint NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_courier_allocation (shopid, remittance_id, collection_id),
  KEY idx_courier_allocation_collection (shopid, collection_id),
  CONSTRAINT fk_courier_allocation_remittance FOREIGN KEY (shopid, courier_id, remittance_id)
    REFERENCES courier_cash_remittances (shopid, courier_id, id),
  CONSTRAINT fk_courier_allocation_collection FOREIGN KEY (shopid, courier_id, collection_id)
    REFERENCES delivery_payment_collections (shopid, courier_id, id),
  CONSTRAINT chk_courier_allocation_money CHECK (amount_cents BETWEEN 1 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE courier_cash_adjustments (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  courier_id int(11) NOT NULL,
  collection_id bigint unsigned DEFAULT NULL,
  remittance_id bigint unsigned DEFAULT NULL,
  delta_due_cents bigint NOT NULL,
  reason text NOT NULL,
  actor_id int(11) NOT NULL,
  idempotency_key varchar(191) COLLATE utf8mb4_bin NOT NULL,
  request_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result json NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_courier_adjustment_idempotency (shopid, idempotency_key),
  KEY idx_courier_adjustment_date (shopid, courier_id, created_at),
  KEY idx_courier_adjustment_collection (shopid, collection_id),
  KEY idx_courier_adjustment_remittance (shopid, remittance_id),
  CONSTRAINT fk_courier_adjustment_courier FOREIGN KEY (shopid, courier_id) REFERENCES users (shopid, id),
  CONSTRAINT fk_courier_adjustment_actor FOREIGN KEY (shopid, actor_id) REFERENCES users (shopid, id),
  CONSTRAINT fk_courier_adjustment_collection FOREIGN KEY (shopid, courier_id, collection_id)
    REFERENCES delivery_payment_collections (shopid, courier_id, id),
  CONSTRAINT fk_courier_adjustment_remittance FOREIGN KEY (shopid, courier_id, remittance_id)
    REFERENCES courier_cash_remittances (shopid, courier_id, id),
  CONSTRAINT chk_courier_adjustment_source CHECK (collection_id IS NOT NULL OR remittance_id IS NOT NULL),
  CONSTRAINT chk_courier_adjustment_money CHECK (delta_due_cents BETWEEN -9007199254740991 AND 9007199254740991 AND delta_due_cents <> 0),
  CONSTRAINT chk_courier_adjustment_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mutable derived counters live outside the immutable financial journal.
CREATE TABLE courier_cash_allocation_totals (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  courier_id int(11) NOT NULL,
  collection_id bigint unsigned DEFAULT NULL,
  remittance_id bigint unsigned DEFAULT NULL,
  allocated_cents bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_courier_total_collection (shopid, collection_id),
  UNIQUE KEY uq_courier_total_remittance (shopid, remittance_id),
  CONSTRAINT fk_courier_total_collection FOREIGN KEY (shopid, courier_id, collection_id)
    REFERENCES delivery_payment_collections (shopid, courier_id, id),
  CONSTRAINT fk_courier_total_remittance FOREIGN KEY (shopid, courier_id, remittance_id)
    REFERENCES courier_cash_remittances (shopid, courier_id, id),
  CONSTRAINT chk_courier_total_source CHECK ((collection_id IS NULL) <> (remittance_id IS NULL)),
  CONSTRAINT chk_courier_total_money CHECK (allocated_cents BETWEEN 0 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE service_rate_limits (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  scope varchar(64) COLLATE utf8mb4_bin NOT NULL,
  subject_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  window_start datetime NOT NULL,
  expires_at datetime NOT NULL,
  attempts int unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_rate_limit_window (shopid, scope, subject_hash, window_start),
  KEY idx_service_rate_limit_expiry (shopid, expires_at),
  CONSTRAINT fk_service_rate_limit_shop FOREIGN KEY (shopid) REFERENCES shop (id),
  CONSTRAINT chk_service_rate_limit_window CHECK (expires_at > window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lock source rows in a stable order, then read counters with current reads.
-- A trigger cannot perform locking reads of its own allocations table in MySQL.
CREATE TRIGGER delivery_allocation_cap BEFORE INSERT ON courier_cash_remittance_allocations
FOR EACH ROW
BEGIN
  DECLARE collection_amount bigint DEFAULT NULL;
  DECLARE collection_courier int DEFAULT NULL;
  DECLARE collection_method varchar(32) DEFAULT NULL;
  DECLARE remittance_amount bigint DEFAULT NULL;
  DECLARE remittance_courier int DEFAULT NULL;
  DECLARE allocated_collection bigint DEFAULT 0;
  DECLARE allocated_remittance bigint DEFAULT 0;
  SELECT amount_cents, courier_id, method INTO collection_amount, collection_courier, collection_method
    FROM delivery_payment_collections WHERE shopid = NEW.shopid AND id = NEW.collection_id FOR UPDATE;
  SELECT received_cents, courier_id INTO remittance_amount, remittance_courier
    FROM courier_cash_remittances WHERE shopid = NEW.shopid AND id = NEW.remittance_id FOR UPDATE;
  IF collection_amount IS NULL OR remittance_amount IS NULL OR collection_method <> 'cash' OR
    collection_courier <> remittance_courier THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid cash allocation sources';
  END IF;
  SET NEW.courier_id = collection_courier;
  INSERT IGNORE INTO courier_cash_allocation_totals (shopid, courier_id, collection_id)
    VALUES (NEW.shopid, collection_courier, NEW.collection_id);
  INSERT IGNORE INTO courier_cash_allocation_totals (shopid, courier_id, remittance_id)
    VALUES (NEW.shopid, remittance_courier, NEW.remittance_id);
  SELECT allocated_cents INTO allocated_collection FROM courier_cash_allocation_totals
    WHERE shopid = NEW.shopid AND collection_id = NEW.collection_id FOR UPDATE;
  SELECT allocated_cents INTO allocated_remittance FROM courier_cash_allocation_totals
    WHERE shopid = NEW.shopid AND remittance_id = NEW.remittance_id FOR UPDATE;
  IF allocated_collection + NEW.amount_cents > collection_amount OR allocated_remittance + NEW.amount_cents > remittance_amount THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cash allocation exceeds collection or remittance';
  END IF;
END;

-- Only count rows actually inserted, including when INSERT IGNORE skips a duplicate.
CREATE TRIGGER delivery_allocation_count AFTER INSERT ON courier_cash_remittance_allocations
FOR EACH ROW
BEGIN
  UPDATE courier_cash_allocation_totals SET allocated_cents = allocated_cents + NEW.amount_cents
    WHERE shopid = NEW.shopid AND collection_id = NEW.collection_id;
  UPDATE courier_cash_allocation_totals SET allocated_cents = allocated_cents + NEW.amount_cents
    WHERE shopid = NEW.shopid AND remittance_id = NEW.remittance_id;
END;

CREATE TRIGGER delivery_charge_no_update BEFORE UPDATE ON delivery_charge_snapshots
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Delivery charge snapshots are append-only';
CREATE TRIGGER delivery_charge_no_delete BEFORE DELETE ON delivery_charge_snapshots
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Delivery charge snapshots are append-only';
CREATE TRIGGER delivery_events_no_update BEFORE UPDATE ON delivery_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Delivery events are append-only';
CREATE TRIGGER delivery_events_no_delete BEFORE DELETE ON delivery_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Delivery events are append-only';
CREATE TRIGGER delivery_collections_no_update BEFORE UPDATE ON delivery_payment_collections
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Delivery collections are append-only';
CREATE TRIGGER delivery_collections_no_delete BEFORE DELETE ON delivery_payment_collections
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Delivery collections are append-only';
CREATE TRIGGER courier_remittances_no_update BEFORE UPDATE ON courier_cash_remittances
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Courier remittances are append-only';
CREATE TRIGGER courier_remittances_no_delete BEFORE DELETE ON courier_cash_remittances
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Courier remittances are append-only';
CREATE TRIGGER courier_allocations_no_update BEFORE UPDATE ON courier_cash_remittance_allocations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Courier allocations are append-only';
CREATE TRIGGER courier_allocations_no_delete BEFORE DELETE ON courier_cash_remittance_allocations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Courier allocations are append-only';
CREATE TRIGGER courier_adjustments_no_update BEFORE UPDATE ON courier_cash_adjustments
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Courier adjustments are append-only';
CREATE TRIGGER courier_adjustments_no_delete BEFORE DELETE ON courier_cash_adjustments
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Courier adjustments are append-only';

-- migrate:down

DROP TABLE service_rate_limits;
DROP TABLE courier_cash_allocation_totals;
DROP TABLE courier_cash_adjustments;
DROP TABLE courier_cash_remittance_allocations;
DROP TABLE courier_cash_remittances;
DROP TABLE delivery_payment_collections;
DROP TABLE delivery_events;
DROP TABLE delivery_charge_snapshots;
ALTER TABLE archives
  DROP FOREIGN KEY fk_archives_delivery,
  DROP KEY uq_archives_delivery,
  DROP KEY idx_archives_shop_delivery,
  DROP KEY idx_archives_customer_account,
  DROP COLUMN fulfillment_type,
  DROP COLUMN customer_account_id,
  DROP COLUMN delivery_id;
ALTER TABLE orders
  DROP FOREIGN KEY fk_orders_delivery,
  DROP KEY uq_orders_delivery,
  DROP KEY idx_orders_shop_delivery,
  DROP KEY idx_orders_customer_account,
  DROP COLUMN fulfillment_type,
  DROP COLUMN customer_account_id,
  DROP COLUMN delivery_id;
DROP TABLE deliveries;
DROP TABLE shop_delivery_fee_bands;
DROP TABLE shop_delivery_settings;
ALTER TABLE payments DROP KEY uq_delivery_payments_shop_id;
ALTER TABLE users DROP KEY uq_delivery_users_shop_id, DROP COLUMN courier_available;
ALTER TABLE shop DROP KEY uq_delivery_shop_id;
