-- migrate:up
CREATE TABLE delivery_register_payments (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  delivery_id bigint unsigned NOT NULL,
  payment_id int(11) NOT NULL,
  operator_id int(11) NOT NULL,
  method enum('cash','external_card','cheque','meal_voucher') NOT NULL,
  payment_label varchar(191) NOT NULL,
  amount_cents bigint NOT NULL,
  created_at datetime(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_register_delivery (shopid,delivery_id),
  UNIQUE KEY uq_register_payment (shopid,payment_id),
  UNIQUE KEY uq_register_refund_source (shopid,delivery_id,payment_id,id,method,amount_cents),
  CONSTRAINT fk_register_delivery FOREIGN KEY (shopid,delivery_id) REFERENCES deliveries (shopid,id),
  CONSTRAINT fk_register_payment FOREIGN KEY (shopid,payment_id) REFERENCES payments (shop_id,id),
  CONSTRAINT fk_register_operator FOREIGN KEY (shopid,operator_id) REFERENCES users (shopid,id),
  CONSTRAINT chk_register_payment_money CHECK (amount_cents BETWEEN 1 AND 2147483647)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE delivery_register_refunds (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  shopid int(11) NOT NULL,
  delivery_id bigint unsigned NOT NULL,
  payment_id int(11) NOT NULL,
  register_payment_id bigint unsigned NOT NULL,
  method enum('cash','external_card','cheque','meal_voucher') NOT NULL,
  amount_cents bigint NOT NULL,
  return_source enum('register','external_card','cheque','meal_voucher') NOT NULL,
  physical_holder_id int(11) DEFAULT NULL,
  authorized_by_id int(11) NOT NULL,
  reason text NOT NULL,
  idempotency_key varchar(191) COLLATE utf8mb4_bin NOT NULL,
  request_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result json NOT NULL,
  created_at datetime(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_register_refund_payment (shopid,payment_id),
  UNIQUE KEY uq_register_refund_key (shopid,idempotency_key),
  KEY idx_register_refund_period (shopid,created_at,id),
  CONSTRAINT fk_register_refund_source FOREIGN KEY (shopid,delivery_id,payment_id,register_payment_id,method,amount_cents)
    REFERENCES delivery_register_payments (shopid,delivery_id,payment_id,id,method,amount_cents),
  CONSTRAINT fk_register_refund_authorizer FOREIGN KEY (shopid,authorized_by_id) REFERENCES users (shopid,id),
  CONSTRAINT fk_register_refund_holder FOREIGN KEY (shopid,physical_holder_id) REFERENCES users (shopid,id),
  CONSTRAINT chk_register_refund_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0),
  CONSTRAINT chk_register_refund_return CHECK (
    (method='cash' AND return_source='register' AND physical_holder_id IS NOT NULL AND physical_holder_id=authorized_by_id)
    OR (method<>'cash' AND return_source=method AND physical_holder_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Serialize cross-table origin/key checks on the same shop barrier as producers.
CREATE TRIGGER register_payment_exclusive BEFORE INSERT ON delivery_register_payments FOR EACH ROW
BEGIN
  DECLARE locked_shop int;
  DECLARE other_source bigint unsigned;
  SELECT id INTO locked_shop FROM shop WHERE id=NEW.shopid FOR UPDATE;
  SELECT id INTO other_source FROM delivery_payment_collections WHERE shopid=NEW.shopid
    AND (delivery_id=NEW.delivery_id OR payment_id=NEW.payment_id) LIMIT 1 FOR UPDATE;
  IF other_source IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Delivery payment already has courier origin'; END IF;
END;
CREATE TRIGGER courier_payment_exclusive BEFORE INSERT ON delivery_payment_collections FOR EACH ROW
BEGIN
  DECLARE locked_shop int;
  DECLARE other_source bigint unsigned;
  SELECT id INTO locked_shop FROM shop WHERE id=NEW.shopid FOR UPDATE;
  SELECT id INTO other_source FROM delivery_register_payments WHERE shopid=NEW.shopid
    AND (delivery_id=NEW.delivery_id OR payment_id=NEW.payment_id) LIMIT 1 FOR UPDATE;
  IF other_source IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Delivery payment already has register origin'; END IF;
END;
CREATE TRIGGER register_refund_key_exclusive BEFORE INSERT ON delivery_register_refunds FOR EACH ROW
BEGIN
  DECLARE locked_shop int;
  DECLARE other_refund bigint unsigned;
  SELECT id INTO locked_shop FROM shop WHERE id=NEW.shopid FOR UPDATE;
  SELECT id INTO other_refund FROM delivery_manual_refunds WHERE shopid=NEW.shopid
    AND (idempotency_key=NEW.idempotency_key OR payment_id=NEW.payment_id) LIMIT 1 FOR UPDATE;
  IF other_refund IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Manual refund key or payment already used'; END IF;
END;
CREATE TRIGGER courier_refund_key_exclusive BEFORE INSERT ON delivery_manual_refunds FOR EACH ROW
BEGIN
  DECLARE locked_shop int;
  DECLARE other_refund bigint unsigned;
  SELECT id INTO locked_shop FROM shop WHERE id=NEW.shopid FOR UPDATE;
  SELECT id INTO other_refund FROM delivery_register_refunds WHERE shopid=NEW.shopid
    AND (idempotency_key=NEW.idempotency_key OR payment_id=NEW.payment_id) LIMIT 1 FOR UPDATE;
  IF other_refund IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Manual refund key or payment already used'; END IF;
END;
CREATE TRIGGER register_payments_no_update BEFORE UPDATE ON delivery_register_payments
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Register payment proofs are append-only';
CREATE TRIGGER register_payments_no_delete BEFORE DELETE ON delivery_register_payments
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Register payment proofs are append-only';
CREATE TRIGGER register_refunds_no_update BEFORE UPDATE ON delivery_register_refunds
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Register refunds are append-only';
CREATE TRIGGER register_refunds_no_delete BEFORE DELETE ON delivery_register_refunds
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Register refunds are append-only';

-- migrate:down
DROP TRIGGER courier_refund_key_exclusive;
DROP TRIGGER register_refund_key_exclusive;
DROP TRIGGER courier_payment_exclusive;
DROP TRIGGER register_payment_exclusive;
DROP TABLE delivery_register_refunds;
DROP TABLE delivery_register_payments;
