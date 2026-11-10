-- migrate:up
ALTER TABLE cash_closures
  ADD COLUMN standalone_terminal_summary JSON DEFAULT NULL,
  ADD COLUMN reconciliation JSON DEFAULT NULL;

ALTER TABLE stripe_terminal_payments
  ADD COLUMN cash_closure_id INT DEFAULT NULL,
  ADD KEY idx_terminal_unclosed (shopid, payment_kind, status, cash_closure_id);

-- migrate:down
ALTER TABLE stripe_terminal_payments
  DROP KEY idx_terminal_unclosed,
  DROP COLUMN cash_closure_id;

ALTER TABLE cash_closures
  DROP COLUMN reconciliation,
  DROP COLUMN standalone_terminal_summary;
