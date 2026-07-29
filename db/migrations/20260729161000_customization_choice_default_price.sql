-- migrate:up

ALTER TABLE `customization_step_choices`
  ADD COLUMN `default_extra_price` decimal(10,2) NOT NULL DEFAULT 0.00
  AFTER `linked_product_id`;

UPDATE `customization_step_choices` choice
JOIN (
  SELECT step_choice_id, MIN(extra_price) AS default_extra_price
  FROM product_customization_step_choices
  GROUP BY step_choice_id
) product_choice ON product_choice.step_choice_id = choice.id
SET choice.default_extra_price = product_choice.default_extra_price;

-- migrate:down

ALTER TABLE `customization_step_choices`
  DROP COLUMN `default_extra_price`;
