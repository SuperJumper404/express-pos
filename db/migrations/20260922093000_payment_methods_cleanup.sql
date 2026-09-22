-- migrate:up

UPDATE `archives`
SET `used_payment_method` = 'Stripe'
WHERE LOWER(TRIM(COALESCE(`payment_provider`, ''))) LIKE '%stripe%'
   OR LOWER(TRIM(COALESCE(`payment`, ''))) LIKE '%stripe%';

UPDATE `orders`
SET `payment` = 'Carte bancaire'
WHERE LOWER(TRIM(COALESCE(`payment`, ''))) = 'autre';

UPDATE `archives`
SET `payment` = 'Carte bancaire'
WHERE LOWER(TRIM(COALESCE(`payment`, ''))) = 'autre';

UPDATE `archives`
SET `used_payment_method` = 'Carte bancaire'
WHERE LOWER(TRIM(COALESCE(`used_payment_method`, ''))) = 'autre';

UPDATE `shop`
SET `shop_payment_methods` = REPLACE(
  REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(`shop_payment_methods`, 'Tickets Restaurants', 'Ticket restaurant'),
            'Ticket Restaurant', 'Ticket restaurant'
          ),
          'Ticket restaurants', 'Ticket restaurant'
        ),
        'Tickets Restaurant', 'Ticket restaurant'
      ),
      'Tickets resto', 'Ticket restaurant'
    ),
    'Ticket resto', 'Ticket restaurant'
  ),
  '"Carte"', '"Carte bancaire"'
);

-- migrate:down

-- Cleanup migration is intentionally irreversible.
