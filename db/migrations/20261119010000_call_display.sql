-- migrate:up
ALTER TABLE service_points MODIFY type ENUM('counter','click_collect','table','kiosk','call_display') NOT NULL;
-- MySQL may have committed the column and index on an earlier attempt.
SET @call_display_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='status_entered_at'),
  'SELECT 1',
  'ALTER TABLE orders ADD status_entered_at DATETIME(6) NULL, ADD INDEX idx_call_display_orders (shopid,status,status_entered_at,id)'
);
PREPARE call_display_ddl FROM @call_display_ddl;
EXECUTE call_display_ddl;
DEALLOCATE PREPARE call_display_ddl;

CREATE TRIGGER IF NOT EXISTS orders_call_status_insert BEFORE INSERT ON orders
FOR EACH ROW SET NEW.status_entered_at = UTC_TIMESTAMP(6);
CREATE TRIGGER IF NOT EXISTS orders_call_status_update BEFORE UPDATE ON orders
FOR EACH ROW SET NEW.status_entered_at = IF(NEW.status <> OLD.status, UTC_TIMESTAMP(6), COALESCE(OLD.status_entered_at, NEW.status_entered_at));
UPDATE orders SET status_entered_at = CASE WHEN status IN (2,3) AND finished >= created THEN finished ELSE created END
WHERE status_entered_at IS NULL AND status IN (1,2,3);

-- migrate:down
DROP TRIGGER orders_call_status_update;
DROP TRIGGER orders_call_status_insert;
ALTER TABLE orders DROP INDEX idx_call_display_orders, DROP COLUMN status_entered_at;
UPDATE service_points SET is_active=0, type='kiosk' WHERE type='call_display';
ALTER TABLE service_points MODIFY type ENUM('counter','click_collect','table','kiosk') NOT NULL;
