-- migrate:up

ALTER TABLE stripe_terminal_payments
  ADD COLUMN payment_kind enum('order','standalone') NOT NULL DEFAULT 'order',
  ADD COLUMN confirmed_at datetime DEFAULT NULL,
  ADD KEY idx_terminal_payment_history (shopid, payment_kind, confirmed_at, created_at, id);

CREATE TABLE stripe_terminal_payment_attachments (
  shopid int NOT NULL,
  terminal_payment_id int NOT NULL,
  archive_id int NOT NULL,
  order_number varchar(255) NOT NULL,
  amount_cents int NOT NULL,
  attached_by_user_id int NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_terminal_attachment (terminal_payment_id, archive_id),
  KEY idx_terminal_attachment_shop_payment (shopid, terminal_payment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down

DROP TABLE IF EXISTS stripe_terminal_payment_attachments;
ALTER TABLE stripe_terminal_payments
  DROP KEY idx_terminal_payment_history,
  DROP COLUMN confirmed_at,
  DROP COLUMN payment_kind;
