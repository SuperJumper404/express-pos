-- migrate:up
ALTER TABLE stripe_terminal_payment_attachments
  MODIFY COLUMN archive_id int DEFAULT NULL,
  ADD COLUMN order_id int DEFAULT NULL,
  ADD UNIQUE KEY uq_terminal_attachment_order (terminal_payment_id, order_id),
  ADD KEY idx_terminal_attachment_order_source (shopid, order_id);

-- migrate:down
DELETE FROM stripe_terminal_payment_attachments WHERE archive_id IS NULL;
ALTER TABLE stripe_terminal_payment_attachments
  DROP KEY idx_terminal_attachment_order_source,
  DROP KEY uq_terminal_attachment_order,
  DROP COLUMN order_id,
  MODIFY COLUMN archive_id int NOT NULL;
