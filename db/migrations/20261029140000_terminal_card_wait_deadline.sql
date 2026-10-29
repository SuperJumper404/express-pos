-- migrate:up

ALTER TABLE stripe_terminal_payments
  ADD COLUMN card_wait_started_at datetime(3) DEFAULT NULL,
  ADD COLUMN reader_label varchar(255) DEFAULT NULL,
  ADD KEY idx_terminal_card_wait (status, card_wait_started_at, id);

UPDATE stripe_terminal_payments p
JOIN stripe_terminal_readers r ON r.id = p.terminal_reader_id AND r.shopid = p.shopid
SET p.reader_label = r.label;

-- Only legacy rows already handed to the reader have a known card wait.
UPDATE stripe_terminal_payments
SET card_wait_started_at = created_at
WHERE status = 'processing' AND stripe_payment_intent_id IS NOT NULL;

-- migrate:down

ALTER TABLE stripe_terminal_payments
  DROP KEY idx_terminal_card_wait,
  DROP COLUMN reader_label,
  DROP COLUMN card_wait_started_at;
