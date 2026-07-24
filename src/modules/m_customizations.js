const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { withTransaction } = require("../helpers/withTransaction");

const isDisabled = (value) => value === false
  || value === 0
  || (typeof value === "string" && ["0", "false"].includes(value.trim().toLowerCase()));
const isEnabled = (value) => value === true || value === 1 || value === "1";
const idKey = (value) => String(value);
const isValidCatalogId = (value) => {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return false;
  const numericValue = Number(value.trim());
  return Number.isSafeInteger(numericValue) && numericValue > 0;
};

const queryRows = async (connection, sql, params) => {
  const [rows] = await (connection || pool).query(sql, params);
  return rows;
};

const setAvailableConfigurationMetadata = (steps) => {
  Object.defineProperties(steps, {
    customization_available: { value: true, writable: true, configurable: true },
    blocking_product_step_id: { value: null, writable: true, configurable: true },
    unavailable_reason: { value: null, writable: true, configurable: true },
  });
  return steps;
};

const getProductCustomizationState = (steps) => ({
  customization_available: steps.customization_available !== false,
  product_step_id: steps.blocking_product_step_id || null,
  reason: steps.unavailable_reason || null,
});

const groupResolvedConfigurationRows = (rows) => {
  const configurations = new Map();
  const stepsByProduct = new Map();

  for (const row of rows) {
    if (!configurations.has(row.product_id)) {
      configurations.set(row.product_id, []);
      stepsByProduct.set(row.product_id, new Map());
    }

    const productSteps = configurations.get(row.product_id);
    const stepsById = stepsByProduct.get(row.product_id);
    let step = stepsById.get(row.product_step_id);
    if (!step) {
      step = {
        product_step_id: row.product_step_id,
        step_id: row.step_id,
        name: row.step_name,
        description: row.step_description,
        position: row.step_position,
        minimum_choices: row.minimum_choices,
        maximum_choices: row.maximum_choices,
        active: !isDisabled(row.product_step_active) && !isDisabled(row.step_active),
        choices: [],
      };
      stepsById.set(row.product_step_id, step);
      productSteps.push(step);
    }

    if (row.product_step_choice_id != null) {
      const active = !isDisabled(row.product_step_active)
        && !isDisabled(row.step_active)
        && !isDisabled(row.product_step_choice_active)
        && !isDisabled(row.choice_active);
      const linkedAvailable = row.choice_type !== "linked_product"
        || (!isEnabled(row.linked_archived) && Number(row.linked_stock) > 0);
      const name = row.choice_type === "linked_product"
        ? row.linked_name
        : row.simple_name;
      const image = row.choice_type === "linked_product"
        ? row.linked_image
        : row.simple_image;

      step.choices.push({
        product_step_choice_id: row.product_step_choice_id,
        step_choice_id: row.step_choice_id,
        choice_type: row.choice_type,
        name,
        choice_name: name,
        image,
        linked_product_id: row.linked_product_id,
        extra_price: row.extra_price,
        position: row.choice_position,
        active,
        available: active && linkedAvailable,
      });
    }
  }

  for (const steps of configurations.values()) {
    steps.sort((left, right) => left.position - right.position);
    setAvailableConfigurationMetadata(steps);
    for (const step of steps) {
      step.choices.sort((left, right) => left.position - right.position);
      step.available_choice_count = step.choices.filter((choice) => choice.available).length;
      step.available = step.active && step.available_choice_count >= step.minimum_choices;
      if (step.available_choice_count < step.minimum_choices) {
        step.unavailable_reason = {
          code: "INSUFFICIENT_AVAILABLE_CHOICES",
          available_choice_count: step.available_choice_count,
          minimum_choices: step.minimum_choices,
        };
        if (steps.customization_available) {
          steps.customization_available = false;
          steps.blocking_product_step_id = step.product_step_id;
          steps.unavailable_reason = step.unavailable_reason;
        }
      } else {
        step.unavailable_reason = null;
      }
    }
  }

  return configurations;
};

const RESOLVED_PRODUCT_CONFIGURATIONS_SQL = `
  SELECT
    p.id AS product_id,
    product_step.id AS product_step_id,
    product_step.step_id,
    step.name AS step_name,
    step.description AS step_description,
    product_step.minimum_choices,
    product_step.maximum_choices,
    product_step.position AS step_position,
    product_step.active AS product_step_active,
    step.active AS step_active,
    product_choice.id AS product_step_choice_id,
    product_choice.step_choice_id,
    step_choice.choice_type,
    step_choice.name AS simple_name,
    step_choice.image AS simple_image,
    step_choice.linked_product_id,
    linked_product.name AS linked_name,
    linked_product.image AS linked_image,
    linked_product.stock AS linked_stock,
    linked_product.archived AS linked_archived,
    linked_product.is_hidden AS linked_is_hidden,
    product_choice.extra_price,
    product_choice.position AS choice_position,
    product_choice.active AS product_step_choice_active,
    step_choice.active AS choice_active
  FROM products p
  LEFT JOIN product_customization_steps product_step
    ON product_step.product_id = p.id
  LEFT JOIN customization_steps step
    ON step.id = product_step.step_id
  LEFT JOIN product_customization_step_choices product_choice
    ON product_choice.product_customization_step_id = product_step.id
  LEFT JOIN customization_step_choices step_choice
    ON step_choice.id = product_choice.step_choice_id
    AND step_choice.step_id = step.id
  LEFT JOIN products linked_product
    ON linked_product.id = step_choice.linked_product_id
  WHERE p.shopid = ? AND p.id IN (?)
  ORDER BY p.id, product_step.position, product_step.id,
    product_choice.position, product_choice.id
`;

const getResolvedProductConfigurations = async ({
  shopId,
  productIds,
  connection,
}) => {
  const idsByKey = new Map();
  for (const productId of productIds || []) {
    const key = idKey(productId);
    if (!idsByKey.has(key)) idsByKey.set(key, productId);
  }
  const ids = [...idsByKey.values()];
  const configurations = new Map();
  for (const productId of ids) {
    configurations.set(productId, setAvailableConfigurationMetadata([]));
  }
  if (ids.length === 0) return configurations;

  const rows = await queryRows(
    connection,
    RESOLVED_PRODUCT_CONFIGURATIONS_SQL,
    [shopId, ids],
  );
  const grouped = groupResolvedConfigurationRows(
    rows.filter((row) => row.product_step_id != null),
  );
  for (const [productId, steps] of grouped) {
    const key = idKey(productId);
    if (idsByKey.has(key)) configurations.set(idsByKey.get(key), steps);
  }
  return configurations;
};

const LIST_CUSTOMIZATION_STEPS_SQL = `
  SELECT
    step.id AS step_id,
    step.name AS step_name,
    step.description AS step_description,
    step.active AS step_active,
    step.created AS step_created,
    step.updated AS step_updated,
    choice.id AS choice_id,
    choice.choice_type,
    choice.name AS simple_name,
    choice.image AS simple_image,
    choice.linked_product_id,
    linked_product.name AS linked_name,
    linked_product.image AS linked_image,
    linked_product.stock AS linked_stock,
    linked_product.archived AS linked_archived,
    linked_product.is_hidden AS linked_is_hidden,
    choice.default_position,
    choice.active AS choice_active,
    choice.created AS choice_created,
    choice.updated AS choice_updated
  FROM customization_steps step
  LEFT JOIN customization_step_choices choice ON choice.step_id = step.id
  LEFT JOIN products linked_product ON linked_product.id = choice.linked_product_id
  WHERE step.shop_id = ?
  ORDER BY step.id, choice.default_position, choice.id
`;

const groupCustomizationStepRows = (rows) => {
  const steps = [];
  const stepsById = new Map();
  for (const row of rows) {
    let step = stepsById.get(row.step_id);
    if (!step) {
      step = {
        id: row.step_id,
        name: row.step_name,
        description: row.step_description,
        active: !isDisabled(row.step_active),
        created: row.step_created,
        updated: row.step_updated,
        choices: [],
      };
      stepsById.set(row.step_id, step);
      steps.push(step);
    }
    if (row.choice_id == null) continue;
    const name = row.choice_type === "linked_product"
      ? row.linked_name
      : row.simple_name;
    const image = row.choice_type === "linked_product"
      ? row.linked_image
      : row.simple_image;
    const linkedAvailable = row.choice_type !== "linked_product"
      || (!isEnabled(row.linked_archived) && Number(row.linked_stock) > 0);
    step.choices.push({
      id: row.choice_id,
      step_id: row.step_id,
      choice_type: row.choice_type,
      name,
      image,
      linked_product_id: row.linked_product_id,
      default_position: row.default_position,
      active: !isDisabled(row.choice_active),
      available: !isDisabled(row.step_active)
        && !isDisabled(row.choice_active)
        && linkedAvailable,
      created: row.choice_created,
      updated: row.choice_updated,
    });
  }
  return steps;
};

const listCustomizationSteps = async (shopId, connection) => groupCustomizationStepRows(
  await queryRows(connection, LIST_CUSTOMIZATION_STEPS_SQL, [shopId]),
);

const GET_CUSTOMIZATION_STEP_SQL = LIST_CUSTOMIZATION_STEPS_SQL.replace(
  "WHERE step.shop_id = ?",
  "WHERE step.shop_id = ? AND step.id = ?",
);

const getCustomizationStep = async ({ shopId, stepId, connection }) => {
  const steps = groupCustomizationStepRows(
    await queryRows(connection, GET_CUSTOMIZATION_STEP_SQL, [shopId, stepId]),
  );
  return steps[0] || null;
};

const createCustomizationStep = ({ shopId, data, connection }) => queryRows(connection, `
  INSERT INTO customization_steps (
    shop_id, name, description, active, created, updated
  ) VALUES (?, ?, ?, ?, NOW(), NULL)
`, [
  shopId,
  data.name,
  data.description == null ? null : data.description,
  isDisabled(data.active) ? 0 : 1,
]);

const updateCustomizationStep = async ({ shopId, stepId, data, connection }) => {
  const current = await getCustomizationStep({ shopId, stepId, connection });
  if (!current) {
    throw new DomainError(
      404,
      "CUSTOMIZATION_STEP_NOT_FOUND",
      "Customization step does not belong to this shop",
      { step_id: stepId },
    );
  }
  return queryRows(connection, `
    UPDATE customization_steps
    SET name = ?, description = ?, active = ?, updated = NOW()
    WHERE id = ? AND shop_id = ?
  `, [
    data.name == null ? current.name : data.name,
    data.description === undefined ? current.description : data.description,
    data.active === undefined ? (current.active ? 1 : 0) : (isDisabled(data.active) ? 0 : 1),
    stepId,
    shopId,
  ]);
};

const deleteCustomizationStepInConnection = async ({ shopId, stepId, connection }) => {
  const current = await getCustomizationStep({ shopId, stepId, connection });
  if (!current) {
    throw new DomainError(
      404,
      "CUSTOMIZATION_STEP_NOT_FOUND",
      "Customization step does not belong to this shop",
      { step_id: stepId },
    );
  }

  const imageRows = await queryRows(connection, `
    SELECT choice.image
    FROM customization_step_choices choice
    WHERE choice.step_id = ? AND choice.image IS NOT NULL
  `, [stepId]);

  await queryRows(connection, `
    DELETE product_choice
    FROM product_customization_step_choices product_choice
    JOIN product_customization_steps product_step
      ON product_step.id = product_choice.product_customization_step_id
    WHERE product_step.step_id = ?
  `, [stepId]);
  await queryRows(connection, `
    DELETE FROM product_customization_steps
    WHERE step_id = ?
  `, [stepId]);
  await queryRows(connection, `
    DELETE FROM customization_step_choices
    WHERE step_id = ?
  `, [stepId]);
  const result = await queryRows(connection, `
    DELETE FROM customization_steps
    WHERE id = ? AND shop_id = ?
  `, [stepId, shopId]);

  return {
    affectedRows: result.affectedRows,
    images: imageRows.map(({ image }) => image).filter(Boolean),
  };
};

const deleteCustomizationStep = ({ shopId, stepId, connection }) => {
  if (connection) {
    return deleteCustomizationStepInConnection({ shopId, stepId, connection });
  }
  return withTransaction((transactionConnection) => deleteCustomizationStepInConnection({
    shopId,
    stepId,
    connection: transactionConnection,
  }));
};

const requireOwnedStep = async ({ shopId, stepId, connection }) => {
  const rows = await queryRows(connection, `
    SELECT step.id FROM customization_steps step
    WHERE step.id = ? AND step.shop_id = ?
  `, [stepId, shopId]);
  if (rows.length !== 1) {
    throw new DomainError(
      404,
      "CUSTOMIZATION_STEP_NOT_FOUND",
      "Customization step does not belong to this shop",
      { step_id: stepId },
    );
  }
};

const getOwnedChoiceRecord = async ({ shopId, choiceId, connection }) => {
  const rows = await queryRows(connection, `
    SELECT
      choice.id,
      choice.step_id,
      choice.choice_type,
      choice.name,
      choice.image,
      choice.linked_product_id,
      choice.default_position,
      choice.active
    FROM customization_step_choices choice
    JOIN customization_steps step ON step.id = choice.step_id
    WHERE choice.id = ? AND step.shop_id = ?
  `, [choiceId, shopId]);
  if (rows.length !== 1) {
    throw new DomainError(
      404,
      "CUSTOMIZATION_CHOICE_NOT_FOUND",
      "Customization choice does not belong to this shop",
      { choice_id: choiceId },
    );
  }
  return rows[0];
};

const normalizeChoiceData = async ({ shopId, data, connection }) => {
  if (data.choice_type !== "simple" && data.choice_type !== "linked_product") {
    throw configurationError(
      "CUSTOMIZATION_CHOICE_TYPE_INVALID",
      "Customization choice type is invalid",
    );
  }
  if (data.choice_type === "simple") {
    if (typeof data.name !== "string" || data.name.trim() === "") {
      throw configurationError(
        "CUSTOMIZATION_CHOICE_NAME_REQUIRED",
        "A simple customization choice requires a name",
      );
    }
    return {
      ...data,
      linked_product_id: null,
    };
  }
  const products = await queryRows(connection, `
    SELECT id FROM products WHERE id = ? AND shopid = ?
  `, [data.linked_product_id, shopId]);
  if (products.length !== 1) {
    throw configurationError(
      "CUSTOMIZATION_LINKED_PRODUCT_NOT_OWNED",
      "Linked product does not belong to this shop",
      { product_id: data.linked_product_id },
    );
  }
  return {
    ...data,
    name: null,
    image: null,
  };
};

const createCustomizationChoice = async ({ shopId, stepId, data, connection }) => {
  await requireOwnedStep({ shopId, stepId, connection });
  const choice = await normalizeChoiceData({ shopId, data, connection });
  return queryRows(connection, `
    INSERT INTO customization_step_choices (
      step_id, choice_type, name, image, linked_product_id,
      default_position, active, created, updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NULL)
  `, [
    stepId,
    choice.choice_type,
    choice.name,
    choice.image == null ? null : choice.image,
    choice.linked_product_id == null ? null : choice.linked_product_id,
    choice.default_position == null ? 0 : choice.default_position,
    isDisabled(choice.active) ? 0 : 1,
  ]);
};

const updateCustomizationChoice = async ({ shopId, choiceId, data, connection }) => {
  const current = await getOwnedChoiceRecord({ shopId, choiceId, connection });
  const choice = await normalizeChoiceData({
    shopId,
    connection,
    data: {
      choice_type: data.choice_type || current.choice_type,
      name: data.name === undefined ? current.name : data.name,
      image: data.image === undefined ? current.image : data.image,
      linked_product_id: data.linked_product_id === undefined
        ? current.linked_product_id
        : data.linked_product_id,
      default_position: data.default_position === undefined
        ? current.default_position
        : data.default_position,
      active: data.active === undefined ? current.active : data.active,
    },
  });
  return queryRows(connection, `
    UPDATE customization_step_choices choice
    JOIN customization_steps step ON step.id = choice.step_id
    SET choice.choice_type = ?, choice.name = ?, choice.image = ?,
      choice.linked_product_id = ?, choice.default_position = ?,
      choice.active = ?, choice.updated = NOW()
    WHERE choice.id = ? AND step.shop_id = ?
  `, [
    choice.choice_type,
    choice.name,
    choice.image == null ? null : choice.image,
    choice.linked_product_id == null ? null : choice.linked_product_id,
    choice.default_position == null ? 0 : choice.default_position,
    isDisabled(choice.active) ? 0 : 1,
    choiceId,
    shopId,
  ]);
};

const deleteCustomizationChoice = ({ shopId, choiceId, connection }) => queryRows(connection, `
  UPDATE customization_step_choices choice
  JOIN customization_steps step ON step.id = choice.step_id
  SET choice.active = 0, choice.updated = NOW()
  WHERE choice.id = ? AND step.shop_id = ?
`, [choiceId, shopId]);

const configurationError = (code, message, context = {}) => new DomainError(
  422,
  code,
  message,
  context,
);

const validateConfigurationShape = (steps) => {
  if (!Array.isArray(steps)) {
    throw configurationError(
      "CUSTOMIZATION_CONFIG_INVALID",
      "Customization configuration must be an array",
    );
  }
  const stepIds = [];
  const choiceIds = [];
  const stepIdKeys = new Set();
  const choiceIdKeys = new Set();
  for (const step of steps) {
    if (!isValidCatalogId(step.step_id)) {
      throw configurationError(
        "CUSTOMIZATION_STEP_ID_INVALID",
        "Customization step ID is invalid",
        { step_id: step.step_id },
      );
    }
    const stepKey = idKey(step.step_id);
    if (stepIdKeys.has(stepKey)) {
      throw configurationError(
        "CUSTOMIZATION_STEP_DUPLICATE",
        "Customization step is duplicated",
        { step_id: step.step_id },
      );
    }
    stepIdKeys.add(stepKey);
    stepIds.push(step.step_id);
    if (!Number.isInteger(step.minimum_choices)
      || !Number.isInteger(step.maximum_choices)
      || step.minimum_choices < 0
      || step.maximum_choices < 1
      || step.minimum_choices > step.maximum_choices) {
      throw configurationError(
        "CUSTOMIZATION_LIMITS_INVALID",
        "Customization minimum and maximum are invalid",
        { step_id: step.step_id },
      );
    }
    if (!Array.isArray(step.choices)) {
      throw configurationError(
        "CUSTOMIZATION_CHOICES_INVALID",
        "Customization choices must be an array",
        { step_id: step.step_id },
      );
    }
    for (const choice of step.choices) {
      if (!isValidCatalogId(choice.step_choice_id)) {
        throw configurationError(
          "CUSTOMIZATION_CHOICE_ID_INVALID",
          "Customization choice ID is invalid",
          { step_id: step.step_id, choice_id: choice.step_choice_id },
        );
      }
      const choiceKey = idKey(choice.step_choice_id);
      if (choiceIdKeys.has(choiceKey)) {
        throw configurationError(
          "CUSTOMIZATION_CHOICE_DUPLICATE",
          "Customization choice is duplicated",
          { choice_id: choice.step_choice_id },
        );
      }
      choiceIdKeys.add(choiceKey);
      choiceIds.push(choice.step_choice_id);
    }
  }
  return { stepIds, choiceIds };
};

const validateConfigurationOwnership = async ({
  shopId,
  productId,
  steps,
  stepIds,
  choiceIds,
  connection,
}) => {
  const products = await queryRows(connection, `
    SELECT p.id
    FROM products p
    WHERE p.id = ? AND p.shopid = ?
  `, [productId, shopId]);
  if (products.length !== 1) {
    throw new DomainError(
      404,
      "CUSTOMIZATION_PRODUCT_NOT_FOUND",
      "Product does not belong to this shop",
      { product_id: productId },
    );
  }

  let ownedSteps = [];
  if (stepIds.length > 0) {
    ownedSteps = await queryRows(connection, `
      SELECT step.id
      FROM customization_steps step
      WHERE step.shop_id = ? AND step.id IN (?)
    `, [shopId, stepIds]);
  }
  const ownedStepIds = new Set(ownedSteps.map((step) => idKey(step.id)));
  const missingStepId = stepIds.find((stepId) => !ownedStepIds.has(idKey(stepId)));
  if (missingStepId != null) {
    throw configurationError(
      "CUSTOMIZATION_STEP_NOT_OWNED",
      "Customization step does not belong to this shop",
      { step_id: missingStepId },
    );
  }

  let ownedChoices = [];
  if (choiceIds.length > 0) {
    ownedChoices = await queryRows(connection, `
      SELECT
        choice.id,
        choice.step_id,
        choice.choice_type,
        choice.linked_product_id,
        linked_product.shopid AS linked_shop_id
      FROM customization_step_choices choice
      JOIN customization_steps step ON step.id = choice.step_id
      LEFT JOIN products linked_product ON linked_product.id = choice.linked_product_id
      WHERE step.shop_id = ? AND choice.id IN (?)
    `, [shopId, choiceIds]);
  }
  const choicesById = new Map(ownedChoices.map((choice) => [idKey(choice.id), choice]));
  for (const step of steps) {
    for (const configuredChoice of step.choices) {
      const choice = choicesById.get(idKey(configuredChoice.step_choice_id));
      if (!choice) {
        throw configurationError(
          "CUSTOMIZATION_CHOICE_NOT_OWNED",
          "Customization choice does not belong to this shop",
          { choice_id: configuredChoice.step_choice_id },
        );
      }
      if (idKey(choice.step_id) !== idKey(step.step_id)) {
        throw configurationError(
          "CUSTOMIZATION_CHOICE_STEP_MISMATCH",
          "Customization choice does not belong to this step",
          { step_id: step.step_id, choice_id: choice.id },
        );
      }
      if (choice.choice_type === "linked_product") {
        if (idKey(choice.linked_product_id) === idKey(productId)) {
          throw configurationError(
            "CUSTOMIZATION_PARENT_SELF_LINK",
            "A product cannot be its own customization choice",
            { product_id: productId, choice_id: choice.id },
          );
        }
        if (idKey(choice.linked_shop_id) !== idKey(shopId)) {
          throw configurationError(
            "CUSTOMIZATION_LINKED_PRODUCT_NOT_OWNED",
            "Linked product does not belong to this shop",
            { product_id: choice.linked_product_id, choice_id: choice.id },
          );
        }
      }
    }
  }
};

const replaceProductConfigurationInConnection = async ({
  shopId,
  productId,
  steps,
  connection,
}) => {
  const { stepIds, choiceIds } = validateConfigurationShape(steps);
  await validateConfigurationOwnership({
    shopId,
    productId,
    steps,
    stepIds,
    choiceIds,
    connection,
  });

  await queryRows(connection, `
    DELETE FROM product_customization_step_choices
    WHERE product_customization_step_id IN (
      SELECT id FROM product_customization_steps WHERE product_id = ?
    )
  `, [productId]);
  await queryRows(
    connection,
    "DELETE FROM product_customization_steps WHERE product_id = ?",
    [productId],
  );

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const step = steps[stepIndex];
    const stepResult = await queryRows(connection, `
      INSERT INTO product_customization_steps (
        product_id, step_id, position, minimum_choices, maximum_choices,
        active, created, updated
      ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NULL)
    `, [
      productId,
      step.step_id,
      step.position == null ? stepIndex : step.position,
      step.minimum_choices,
      step.maximum_choices,
      isDisabled(step.active) ? 0 : 1,
    ]);
    for (let choiceIndex = 0; choiceIndex < step.choices.length; choiceIndex += 1) {
      const choice = step.choices[choiceIndex];
      await queryRows(connection, `
        INSERT INTO product_customization_step_choices (
          product_customization_step_id, step_choice_id, extra_price,
          position, active
        ) VALUES (?, ?, ?, ?, ?)
      `, [
        stepResult.insertId,
        choice.step_choice_id,
        choice.extra_price == null ? 0 : choice.extra_price,
        choice.position == null ? choiceIndex : choice.position,
        isDisabled(choice.active) ? 0 : 1,
      ]);
    }
  }
  return true;
};

const replaceProductConfiguration = async ({
  shopId,
  productId,
  steps,
  connection,
}) => {
  if (connection) {
    return replaceProductConfigurationInConnection({
      shopId,
      productId,
      steps,
      connection,
    });
  }
  return withTransaction((transactionConnection) => replaceProductConfigurationInConnection({
    shopId,
    productId,
    steps,
    connection: transactionConnection,
  }));
};

module.exports = {
  createCustomizationChoice,
  createCustomizationStep,
  deleteCustomizationChoice,
  deleteCustomizationStep,
  getCustomizationStep,
  getProductCustomizationState,
  getResolvedProductConfigurations,
  groupCustomizationStepRows,
  groupResolvedConfigurationRows,
  listCustomizationSteps,
  replaceProductConfiguration,
  updateCustomizationChoice,
  updateCustomizationStep,
};
