-- migrate:up

UPDATE `orders`
SET `payment` = 'Carte bancaire'
WHERE LOWER(TRIM(COALESCE(`payment`, ''))) = 'autre';

UPDATE `archives`
SET `payment` = 'Carte bancaire'
WHERE LOWER(TRIM(COALESCE(`payment`, ''))) = 'autre';

UPDATE `archives`
SET `used_payment_method` = 'Carte bancaire'
WHERE LOWER(TRIM(COALESCE(`used_payment_method`, ''))) = 'autre';

-- migrate:down

-- The removed fallback category is intentionally not restored.
