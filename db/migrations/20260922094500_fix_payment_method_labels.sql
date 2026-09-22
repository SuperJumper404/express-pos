-- migrate:up

UPDATE `shop`
SET `shop_payment_methods` = REPLACE(
  `shop_payment_methods`,
  'Carte bancaire bancaire',
  'Carte bancaire'
);

-- migrate:down

-- Label correction is intentionally irreversible.
