const DomainError = require("./domainError");
const { parseMoney } = require("./money");

const isDisabled = (value) => value === false || value === 0;

const unavailableStepError = (step, choice) => new DomainError(
  422,
  "CUSTOMIZATION_STEP_UNAVAILABLE",
  "Customization step is unavailable",
  {
    product_step_id: step.product_step_id,
    ...(choice && { product_step_choice_id: choice.product_step_choice_id }),
  },
);

const validateConfiguredItem = ({ product, steps, selectedChoiceIds }) => {
  const selectedIds = selectedChoiceIds || [];
  const choicesById = new Map();

  for (const step of steps) {
    for (const choice of step.choices || []) {
      choicesById.set(choice.product_step_choice_id, { step, choice });
    }
  }

  const seenChoiceIds = new Set();
  const selected = selectedIds.map((choiceId) => {
    if (seenChoiceIds.has(choiceId) || !choicesById.has(choiceId)) {
      throw new DomainError(
        422,
        "CUSTOMIZATION_CHOICE_NOT_ALLOWED",
        "Customization choice is not allowed",
        { product_step_choice_id: choiceId },
      );
    }
    seenChoiceIds.add(choiceId);
    return choicesById.get(choiceId);
  });

  for (const step of steps) {
    if (isDisabled(step.active) || isDisabled(step.available)) {
      throw unavailableStepError(step);
    }
  }

  for (const { step, choice } of selected) {
    if (isDisabled(choice.active) || isDisabled(choice.available)) {
      throw unavailableStepError(step, choice);
    }
  }

  const selectedByStepId = new Map();
  for (const { step } of selected) {
    const stepId = step.product_step_id;
    selectedByStepId.set(stepId, (selectedByStepId.get(stepId) || 0) + 1);
  }

  for (const step of steps) {
    const count = selectedByStepId.get(step.product_step_id) || 0;
    if (count < step.minimum_choices) {
      throw new DomainError(
        422,
        "CUSTOMIZATION_MIN_NOT_MET",
        "Customization minimum is not met",
        { product_step_id: step.product_step_id, minimum_choices: step.minimum_choices, selected_choices: count },
      );
    }
    if (count > step.maximum_choices) {
      throw new DomainError(
        422,
        "CUSTOMIZATION_MAX_EXCEEDED",
        "Customization maximum is exceeded",
        { product_step_id: step.product_step_id, maximum_choices: step.maximum_choices, selected_choices: count },
      );
    }
  }

  const basePrice = parseMoney(product.price);
  const extraPrice = selected.reduce((total, { choice }) => total + parseMoney(choice.extra_price), 0);
  const unitPrice = parseMoney(basePrice + extraPrice);
  const selectedChoices = selected.map(({ step, choice }) => ({
    product_step_choice_id: choice.product_step_choice_id,
    step_id: step.product_step_id,
    step_name: step.name,
    choice_type: choice.choice_type,
    choice_name: choice.choice_name,
    extra_price: parseMoney(choice.extra_price),
    linked_product_id: choice.linked_product_id,
  }));

  return { selectedChoices, unitPrice };
};

module.exports = {
  validateConfiguredItem,
};
