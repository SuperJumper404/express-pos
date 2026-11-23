-- migrate:up
ALTER TABLE users ADD COLUMN terminal_requested_at DATETIME DEFAULT NULL;

CREATE TABLE delivery_checkout_sessions (
  delivery_id BIGINT UNSIGNED NOT NULL,
  shopid INT NOT NULL,
  stripe_session_id VARCHAR(191) NOT NULL,
  amount_cents INT NOT NULL,
  application_fee_cents INT NOT NULL,
  stripe_account_id VARCHAR(191) NOT NULL,
  PRIMARY KEY (shopid, delivery_id),
  UNIQUE KEY uq_delivery_checkout_session (stripe_session_id),
  CONSTRAINT fk_delivery_checkout_delivery FOREIGN KEY (shopid, delivery_id) REFERENCES deliveries (shopid, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TRIGGER delivery_terminal_request_assigned AFTER INSERT ON stripe_terminal_readers FOR EACH ROW
UPDATE users SET terminal_requested_at=NULL
WHERE shopid=NEW.shopid AND id=NEW.assigned_user_id AND NEW.is_active=1 AND terminal_requested_at IS NOT NULL;

CREATE TRIGGER delivery_terminal_request_reassigned AFTER UPDATE ON stripe_terminal_readers FOR EACH ROW
UPDATE users SET terminal_requested_at=NULL
WHERE shopid=NEW.shopid AND id=NEW.assigned_user_id AND NEW.is_active=1 AND terminal_requested_at IS NOT NULL
  AND (OLD.is_active<>NEW.is_active OR NOT (OLD.assigned_user_id <=> NEW.assigned_user_id));

-- migrate:down
-- A live Checkout can still charge until Stripe confirms expiry or payment.
ALTER TABLE delivery_checkout_sessions ADD CONSTRAINT chk_delivery_checkout_empty CHECK (1 = 0);
DROP TRIGGER delivery_terminal_request_reassigned;
DROP TRIGGER delivery_terminal_request_assigned;
DROP TABLE delivery_checkout_sessions;
ALTER TABLE users DROP COLUMN terminal_requested_at;
