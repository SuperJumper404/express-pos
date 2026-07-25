-- migrate:up

ALTER TABLE `orders`
  ADD COLUMN `stripe_replacement_attempt_token` varchar(64) DEFAULT NULL
  AFTER `stripe_payment_intent_id`;

-- migrate:down

ALTER TABLE `orders`
  DROP COLUMN `stripe_replacement_attempt_token`;
