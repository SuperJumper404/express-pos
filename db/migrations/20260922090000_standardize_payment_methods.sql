-- migrate:up

UPDATE `orders`
SET `payment` = 'Stripe'
WHERE LOWER(TRIM(COALESCE(`payment_provider`, ''))) LIKE '%stripe%'
   OR LOWER(TRIM(COALESCE(`payment`, ''))) LIKE '%stripe%';

UPDATE `archives`
SET `payment` = 'Stripe',
    `used_payment_method` = 'Stripe'
WHERE LOWER(TRIM(COALESCE(`payment_provider`, ''))) LIKE '%stripe%'
   OR LOWER(TRIM(COALESCE(`payment`, ''))) LIKE '%stripe%';

UPDATE `orders`
SET `payment` = CASE
  WHEN LOWER(TRIM(`payment`)) IN ('carte', 'carte bancaire', 'cb', 'carte bleu', 'card', 'credit card') THEN 'Carte bancaire'
  WHEN LOWER(TRIM(`payment`)) IN ('espece', 'especes', 'cash') THEN 'Espèces'
  WHEN LOWER(TRIM(`payment`)) IN ('cheque', 'cheques') THEN 'Chèque'
  WHEN LOWER(TRIM(`payment`)) IN ('ticket', 'ticket resto', 'ticket restaurant', 'tickets resto', 'tickets restaurants', 'tickets restaurant') THEN 'Ticket restaurant'
  WHEN TRIM(COALESCE(`payment`, '')) = '' THEN 'Carte bancaire'
  ELSE 'Carte bancaire'
END
WHERE LOWER(TRIM(COALESCE(`payment_provider`, ''))) NOT LIKE '%stripe%'
  AND LOWER(TRIM(COALESCE(`payment`, ''))) NOT LIKE '%stripe%';

UPDATE `archives`
SET `payment` = CASE
  WHEN LOWER(TRIM(`payment`)) IN ('carte', 'carte bancaire', 'cb', 'carte bleu', 'card', 'credit card') THEN 'Carte bancaire'
  WHEN LOWER(TRIM(`payment`)) IN ('espece', 'especes', 'cash') THEN 'Espèces'
  WHEN LOWER(TRIM(`payment`)) IN ('cheque', 'cheques') THEN 'Chèque'
  WHEN LOWER(TRIM(`payment`)) IN ('ticket', 'ticket resto', 'ticket restaurant', 'tickets resto', 'tickets restaurants', 'tickets restaurant') THEN 'Ticket restaurant'
  WHEN TRIM(COALESCE(`payment`, '')) = '' THEN 'Carte bancaire'
  ELSE 'Carte bancaire'
END
WHERE LOWER(TRIM(COALESCE(`payment_provider`, ''))) NOT LIKE '%stripe%'
  AND LOWER(TRIM(COALESCE(`payment`, ''))) NOT LIKE '%stripe%';

UPDATE `archives`
SET `used_payment_method` = CASE
  WHEN LOWER(TRIM(COALESCE(`used_payment_method`, ''))) IN ('carte', 'carte bancaire', 'cb', 'carte bleu', 'card', 'credit card') THEN 'Carte bancaire'
  WHEN LOWER(TRIM(COALESCE(`used_payment_method`, ''))) IN ('espece', 'especes', 'cash') THEN 'Espèces'
  WHEN LOWER(TRIM(COALESCE(`used_payment_method`, ''))) IN ('cheque', 'cheques') THEN 'Chèque'
  WHEN LOWER(TRIM(COALESCE(`used_payment_method`, ''))) IN ('ticket', 'ticket resto', 'ticket restaurant', 'tickets resto', 'tickets restaurants', 'tickets restaurant') THEN 'Ticket restaurant'
  WHEN TRIM(COALESCE(`used_payment_method`, '')) = '' THEN `payment`
  ELSE 'Carte bancaire'
END;

UPDATE `archives`
SET `used_payment_method` = 'Stripe'
WHERE LOWER(TRIM(COALESCE(`payment_provider`, ''))) LIKE '%stripe%'
   OR LOWER(TRIM(COALESCE(`payment`, ''))) LIKE '%stripe%';

UPDATE `shop`
SET `shop_payment_methods` = REPLACE(
  REPLACE(
    REPLACE(
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
      'Cheques', 'Chèque'
    ),
    'Especes', 'Espèces'
  ),
  '"Carte"', '"Carte bancaire"'
);

-- migrate:down

-- Historical payment labels cannot be restored without a separate audit log.
