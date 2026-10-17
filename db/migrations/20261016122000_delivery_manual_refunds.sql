-- migrate:up
ALTER TABLE delivery_payment_collections ADD UNIQUE KEY uq_delivery_collection_refund_source
  (shopid,delivery_id,payment_id,id,courier_id,method,amount_cents);

CREATE TABLE delivery_manual_refunds (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  delivery_id bigint unsigned NOT NULL,
  payment_id int(11) NOT NULL,
  collection_id bigint unsigned NOT NULL,
  courier_id int(11) NOT NULL,
  method enum('cash','external_card') NOT NULL,
  amount_cents bigint NOT NULL,
  return_source enum('register','courier','external_card') NOT NULL,
  physical_holder_id int(11) DEFAULT NULL,
  authorized_by_id int(11) NOT NULL,
  reason text NOT NULL,
  idempotency_key varchar(191) COLLATE utf8mb4_bin NOT NULL,
  request_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result json NOT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_refund_payment (shopid,payment_id),
  UNIQUE KEY uq_delivery_refund_key (shopid,idempotency_key),
  UNIQUE KEY uq_delivery_refund_impact_source (shopid,id,courier_id,collection_id,method,amount_cents,return_source),
  KEY idx_delivery_refund_period (shopid,created_at,id),
  CONSTRAINT fk_delivery_refund_collection FOREIGN KEY (shopid,delivery_id,payment_id,collection_id,courier_id,method,amount_cents)
    REFERENCES delivery_payment_collections (shopid,delivery_id,payment_id,id,courier_id,method,amount_cents),
  CONSTRAINT fk_delivery_refund_authorizer FOREIGN KEY (shopid,authorized_by_id) REFERENCES users (shopid,id),
  CONSTRAINT fk_delivery_refund_physical_holder FOREIGN KEY (shopid,physical_holder_id) REFERENCES users (shopid,id),
  CONSTRAINT chk_delivery_refund_money CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_delivery_refund_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0),
  CONSTRAINT chk_delivery_refund_source CHECK (
    (method='cash' AND ((return_source='courier' AND physical_holder_id=courier_id AND physical_holder_id IS NOT NULL)
      OR (return_source='register' AND physical_holder_id=authorized_by_id AND physical_holder_id IS NOT NULL)))
    OR (method='external_card' AND return_source='external_card' AND physical_holder_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE courier_cash_refund_impacts (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  refund_id bigint unsigned NOT NULL,
  courier_id int(11) NOT NULL,
  collection_id bigint unsigned NOT NULL,
  method enum('cash','external_card') NOT NULL,
  amount_cents bigint NOT NULL,
  return_source enum('register','courier','external_card') NOT NULL,
  due_reduction_cents bigint NOT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_refund_once (shopid,refund_id),
  KEY idx_cash_refund_holder (shopid,courier_id,created_at,id),
  CONSTRAINT fk_cash_refund_confirmed_source FOREIGN KEY (shopid,refund_id,courier_id,collection_id,method,amount_cents,return_source)
    REFERENCES delivery_manual_refunds (shopid,id,courier_id,collection_id,method,amount_cents,return_source),
  CONSTRAINT chk_cash_refund_impact CHECK (
    (method='cash' AND return_source='courier' AND due_reduction_cents=amount_cents)
    OR (return_source IN ('register','external_card') AND due_reduction_cents=0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TRIGGER delivery_manual_refunds_no_update BEFORE UPDATE ON delivery_manual_refunds
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Manual delivery refunds are append-only';
CREATE TRIGGER delivery_manual_refunds_no_delete BEFORE DELETE ON delivery_manual_refunds
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Manual delivery refunds are append-only';
CREATE TRIGGER courier_cash_refunds_no_update BEFORE UPDATE ON courier_cash_refund_impacts
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Courier cash refund impacts are append-only';
CREATE TRIGGER courier_cash_refunds_no_delete BEFORE DELETE ON courier_cash_refund_impacts
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Courier cash refund impacts are append-only';

-- migrate:down
DROP TABLE courier_cash_refund_impacts;
DROP TABLE delivery_manual_refunds;
ALTER TABLE delivery_payment_collections DROP KEY uq_delivery_collection_refund_source;
