const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { copyName } = require("../helpers/catalogDuplication");
const { withTransaction } = require("../helpers/withTransaction");

const isDisabled = (value) => value === false
  || value === 0
  || (typeof value === "string" && ["0", "false"].includes(value.trim().toLowerCase()));
const isEnabled = (value) => value === true || value === 1 || value === "1";
const isLinkedProductAvailable = (row) => row.choice_type !== "linked_product" || (
  !isEnabled(row.linked_archived)
  && (
    isDisabled(row.linked_product_track_stock)
    || row.linked_product_stock_zero_behavior === "warn"
    || Number(row.linked_stock) > 0
  )
);
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
      const linkedAvailable = isLinkedProductAvailable(row);
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
        linked_product_track_stock: row.linked_product_track_stock,
        linked_product_stock_zero_behavior: row.linked_product_stock_zero_behavior,
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
    linked_product.track_stock AS linked_product_track_stock,
    linked_product.stock_zero_behavior AS linked_product_stock_zero_behavior,
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
    linked_product.track_stock AS linked_product_track_stock,
    linked_product.stock_zero_behavior AS linked_product_stock_zero_behavior,
    linked_product.archived AS linked_archived,
    linked_product.is_hidden AS linked_is_hidden,
    choice.default_extra_price,
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
    const linkedAvailable = isLinkedProductAvailable(row);
    step.choices.push({
      id: row.choice_id,
      step_id: row.step_id,
      choice_type: row.choice_type,
      name,
      image,
      linked_product_id: row.linked_product_id,
      default_extra_price: row.default_extra_price,
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

const duplicateCustomizationStep = ({ shopId, stepId, copyImage, connection }) => {
  const duplicate = async (connection) => {
    await requireOwnedStep({ shopId, stepId, connection });
    const [source] = await queryRows(connection, `
      SELECT name, description, active FROM customization_steps
      WHERE id = ? AND shop_id = ?
    `, [stepId, shopId]);
    const choices = await queryRows(connection, `
      SELECT choice_type, name, image, linked_product_id, default_extra_price,
        default_position, active
      FROM customization_step_choices WHERE step_id = ?
      ORDER BY default_position, id
      FOR UPDATE
    `, [stepId]);
    const result = await createCustomizationStep({
      shopId, data: { ...source, name: copyName(source.name) }, connection,
    });
    for (const choice of choices) {
      await queryRows(connection, `
        INSERT INTO customization_step_choices (
          step_id, choice_type, name, image, linked_product_id, default_extra_price,
          default_position, active, created, updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NULL)
      `, [
        result.insertId, choice.choice_type, choice.name, copyImage(choice.image),
        choice.linked_product_id, choice.default_extra_price, choice.default_position, choice.active,
      ]);
    }
    return result;
  };
  return connection ? duplicate(connection) : withTransaction(duplicate);
};

const normalizeStepProductIds = (productIds) => {
  if (!Array.isArray(productIds) || !productIds.length || !productIds.every(isValidCatalogId)) {
    throw configurationError("CUSTOMIZATION_PRODUCTS_INVALID", "Sélectionnez des produits valides.");
  }
  return [...new Set(productIds.map(Number))];
};

const requireOwnedStepProducts = async ({ shopId, productIds, connection }) => {
  const products = await queryRows(connection, `
    SELECT id, archived FROM products WHERE shopid = ? AND id IN (?)
    ORDER BY id FOR UPDATE
  `, [shopId, productIds]);
  if (products.length !== productIds.length) {
    throw configurationError("CUSTOMIZATION_PRODUCTS_NOT_OWNED", "Un produit est introuvable.");
  }
  return products;
};

const attachCustomizationStepToProducts = ({ shopId, stepId, productIds, connection }) => {
  const attach = async (connection) => {
    const ids = normalizeStepProductIds(productIds);
    await requireOwnedStep({ shopId, stepId, connection });
    const step = await getCustomizationStep({ shopId, stepId, connection });
    if (!step.active) {
      throw configurationError("CUSTOMIZATION_STEP_INACTIVE", "Activez l’étape avant de l’ajouter.");
    }
    const products = await requireOwnedStepProducts({ shopId, productIds: ids, connection });
    const current = await queryRows(connection, `
      SELECT product_id, step_id, position FROM product_customization_steps
      WHERE product_id IN (?) ORDER BY product_id, position FOR UPDATE
    `, [ids]);
    const attached = new Set();
    const lastPosition = new Map();
    for (const link of current) {
      const productId = Number(link.product_id);
      if (Number(link.step_id) === Number(stepId)) attached.add(productId);
      lastPosition.set(productId, Math.max(lastPosition.get(productId) ?? -1, Number(link.position)));
    }
    const pending = products.filter(({ id }) => !attached.has(Number(id)));
    if (!pending.length) return { added: 0 };
    const linkedProducts = new Set(step.choices
      .filter((choice) => choice.choice_type === "linked_product")
      .map((choice) => Number(choice.linked_product_id)));
    if (pending.some(({ id, archived }) => isEnabled(archived) || linkedProducts.has(Number(id)))) {
      throw configurationError("CUSTOMIZATION_PRODUCT_INELIGIBLE", "Un produit sélectionné est archivé ou fait partie des choix de cette étape.");
    }
    if (linkedProducts.size) {
      const ownedLinkedProducts = await queryRows(connection, `
        SELECT id FROM products WHERE shopid = ? AND id IN (?)
        ORDER BY id FOR UPDATE
      `, [shopId, [...linkedProducts]]);
      if (ownedLinkedProducts.length !== linkedProducts.size) {
        throw configurationError(
          "CUSTOMIZATION_LINKED_PRODUCT_NOT_OWNED",
          "Un produit utilisé comme choix est introuvable. Vérifiez les choix de cette étape.",
        );
      }
    }
    const choiceValues = [];
    for (const { id } of pending) {
      const result = await queryRows(connection, `
        INSERT INTO product_customization_steps (
          product_id, step_id, position, minimum_choices, maximum_choices, active, created, updated
        ) VALUES (?, ?, ?, 0, ?, 1, NOW(), NULL)
      `, [id, stepId, (lastPosition.get(Number(id)) ?? -1) + 1, Math.max(1, step.choices.length)]);
      for (const choice of step.choices) {
        choiceValues.push([
          result.insertId, choice.id, choice.default_extra_price,
          choice.default_position, choice.active ? 1 : 0,
        ]);
      }
    }
    if (choiceValues.length) {
      await queryRows(connection, `
        INSERT INTO product_customization_step_choices (
          product_customization_step_id, step_choice_id, extra_price, position, active
        ) VALUES ?
      `, [choiceValues]);
    }
    return { added: pending.length };
  };
  return connection ? attach(connection) : withTransaction(attach);
};

const removeCustomizationStepFromProducts = ({ shopId, stepId, productIds, connection }) => {
  const remove = async (connection) => {
    const ids = normalizeStepProductIds(productIds);
    await requireOwnedStep({ shopId, stepId, connection });
    await requireOwnedStepProducts({ shopId, productIds: ids, connection });
    await queryRows(connection, `
      DELETE product_choice
      FROM product_customization_step_choices product_choice
      JOIN product_customization_steps product_step
        ON product_step.id = product_choice.product_customization_step_id
      WHERE product_step.step_id = ? AND product_step.product_id IN (?)
    `, [stepId, ids]);
    const result = await queryRows(connection, `
      DELETE FROM product_customization_steps
      WHERE step_id = ? AND product_id IN (?)
    `, [stepId, ids]);
    return { removed: result.affectedRows };
  };
  return connection ? remove(connection) : withTransaction(remove);
};

const normalizeStepChoicePrices = (prices) => {
  if (!Array.isArray(prices)) {
    throw configurationError(
      "CUSTOMIZATION_CHOICE_PRICES_INVALID",
      "Les tarifs des choix doivent être fournis sous forme de liste.",
    );
  }

  const pricesByChoiceId = new Map();
  for (const entry of prices) {
    const choiceId = entry && entry.choice_id;
    const price = entry && entry.default_extra_price;
    if (!isValidCatalogId(choiceId) || pricesByChoiceId.has(Number(choiceId))) {
      throw configurationError(
        "CUSTOMIZATION_CHOICE_ID_INVALID",
        "Un choix de personnalisation est invalide ou en double.",
        { choice_id: choiceId },
      );
    }
    const amount = typeof price === "number" || typeof price === "string"
      ? String(price).trim()
      : "";
    if (!/^-?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(amount)
      || Math.abs(Number(amount)) > 99999999.99) {
      throw configurationError(
        "CUSTOMIZATION_CHOICE_DEFAULT_PRICE_INVALID",
        "Le prix du choix est invalide.",
        { choice_id: choiceId },
      );
    }
    pricesByChoiceId.set(Number(choiceId), amount);
  }
  return pricesByChoiceId;
};

const updateCustomizationStepInConnection = async ({ shopId, stepId, data, connection }) => {
  const choicePrices = normalizeStepChoicePrices(
    data.choice_prices === undefined ? [] : data.choice_prices,
  );
  const choiceOrder = data.choice_order;
  if (choiceOrder !== undefined && (!Array.isArray(choiceOrder)
    || !choiceOrder.every(isValidCatalogId)
    || new Set(choiceOrder.map(Number)).size !== choiceOrder.length)) {
    throw configurationError(
      "CUSTOMIZATION_CHOICE_ORDER_INVALID",
      "L’ordre des choix est invalide.",
    );
  }
  await requireOwnedStep({ shopId, stepId, connection });
  const current = await getCustomizationStep({ shopId, stepId, connection });
  if (choiceOrder !== undefined || choicePrices.size > 0) {
    const ownedChoices = await queryRows(connection, `
      SELECT id FROM customization_step_choices
      WHERE step_id = ?${choiceOrder === undefined ? " AND id IN (?)" : ""}
      FOR UPDATE
    `, choiceOrder === undefined ? [stepId, [...choicePrices.keys()]] : [stepId]);
    const ownedIds = new Set(ownedChoices.map(({ id }) => Number(id)));
    if (choiceOrder !== undefined && (choiceOrder.length !== ownedIds.size
      || choiceOrder.some((id) => !ownedIds.has(Number(id))))) {
      throw configurationError(
        "CUSTOMIZATION_CHOICE_ORDER_CHANGED",
        "La liste des choix a changé. Rechargez l’étape avant de réessayer.",
        { step_id: stepId },
      );
    }
    if ([...choicePrices.keys()].some((id) => !ownedIds.has(id))) {
      throw configurationError(
        "CUSTOMIZATION_CHOICE_STEP_MISMATCH",
        "Un choix à mettre à jour n’appartient pas à cette étape.",
        { step_id: stepId },
      );
    }
  }
  const result = await queryRows(connection, `
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

  for (const [choiceId, price] of choicePrices) {
    await queryRows(connection, `
      UPDATE customization_step_choices
      SET default_extra_price = ?, updated = NOW()
      WHERE step_id = ? AND id = ?
    `, [price, stepId, choiceId]);
    await queryRows(connection, `
      UPDATE product_customization_step_choices product_choice
      JOIN product_customization_steps product_step
        ON product_step.id = product_choice.product_customization_step_id
      JOIN products product ON product.id = product_step.product_id
      SET product_choice.extra_price = ?
      WHERE product_step.step_id = ? AND product_choice.step_choice_id = ?
        AND product.shopid = ?
    `, [price, stepId, choiceId, shopId]);
  }
  if (choiceOrder && choiceOrder.length > 0) {
    for (const [position, choiceId] of choiceOrder.entries()) {
      await queryRows(connection, `
        UPDATE customization_step_choices
        SET default_position = ?, updated = NOW()
        WHERE step_id = ? AND id = ?
      `, [position, stepId, choiceId]);
    }
    await queryRows(connection, `
      UPDATE product_customization_step_choices product_choice
      JOIN product_customization_steps product_step
        ON product_step.id = product_choice.product_customization_step_id
      JOIN customization_step_choices choice
        ON choice.id = product_choice.step_choice_id AND choice.step_id = product_step.step_id
      JOIN products product ON product.id = product_step.product_id
      SET product_choice.position = choice.default_position
      WHERE product_step.step_id = ? AND product.shopid = ?
    `, [stepId, shopId]);
  }
  return result;
};

const updateCustomizationStep = ({ shopId, stepId, data, connection }) => {
  if (connection) {
    return updateCustomizationStepInConnection({ shopId, stepId, data, connection });
  }
  return withTransaction((transactionConnection) => updateCustomizationStepInConnection({
    shopId,
    stepId,
    data,
    connection: transactionConnection,
  }));
};

const deleteCustomizationStepInConnection = async ({ shopId, stepId, connection }) => {
  await requireOwnedStep({ shopId, stepId, connection });

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
    FOR UPDATE
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
      choice.default_extra_price,
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

const propagateChoiceToProductSteps = async ({
  shopId,
  stepId,
  choiceId,
  choice,
  connection,
}) => {
  const productSteps = await queryRows(connection, `
    SELECT product_step.id AS product_customization_step_id
    FROM product_customization_steps product_step
    JOIN products product ON product.id = product_step.product_id
    WHERE product_step.step_id = ? AND product.shopid = ?
  `, [stepId, shopId]);

  for (const productStep of Array.isArray(productSteps) ? productSteps : []) {
    await queryRows(connection, `
      INSERT INTO product_customization_step_choices (
        product_customization_step_id, step_choice_id, extra_price,
        position, active
      ) VALUES (?, ?, ?, ?, ?)
    `, [
      productStep.product_customization_step_id,
      choiceId,
      choice.default_extra_price == null ? 0 : choice.default_extra_price,
      choice.default_position == null ? 0 : choice.default_position,
      isDisabled(choice.active) ? 0 : 1,
    ]);
  }
};

const createCustomizationChoiceInConnection = async ({
  shopId,
  stepId,
  data,
  connection,
}) => {
  await requireOwnedStep({ shopId, stepId, connection });
  const choice = await normalizeChoiceData({ shopId, data, connection });
  const result = await queryRows(connection, `
    INSERT INTO customization_step_choices (
      step_id, choice_type, name, image, linked_product_id,
      default_extra_price, default_position, active, created, updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NULL)
  `, [
    stepId,
    choice.choice_type,
    choice.name,
    choice.image == null ? null : choice.image,
    choice.linked_product_id == null ? null : choice.linked_product_id,
    choice.default_extra_price == null ? 0 : choice.default_extra_price,
    choice.default_position == null ? 0 : choice.default_position,
    isDisabled(choice.active) ? 0 : 1,
  ]);
  await propagateChoiceToProductSteps({
    shopId,
    stepId,
    choiceId: result.insertId,
    choice,
    connection,
  });
  return result;
};

const createCustomizationChoice = ({ shopId, stepId, data, connection }) => {
  if (connection) {
    return createCustomizationChoiceInConnection({
      shopId,
      stepId,
      data,
      connection,
    });
  }
  return withTransaction((transactionConnection) => createCustomizationChoiceInConnection({
    shopId,
    stepId,
    data,
    connection: transactionConnection,
  }));
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
      default_extra_price: data.default_extra_price === undefined
        ? current.default_extra_price
        : data.default_extra_price,
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
      choice.linked_product_id = ?, choice.default_extra_price = ?,
      choice.default_position = ?,
      choice.active = ?, choice.updated = NOW()
    WHERE choice.id = ? AND step.shop_id = ?
  `, [
    choice.choice_type,
    choice.name,
    choice.image == null ? null : choice.image,
    choice.linked_product_id == null ? null : choice.linked_product_id,
    choice.default_extra_price == null ? 0 : choice.default_extra_price,
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

const deleteCustomizationChoicePermanentlyInConnection = async ({
  shopId,
  choiceId,
  connection,
}) => {
  await getOwnedChoiceRecord({ shopId, choiceId, connection });
  const imageRows = await queryRows(connection, `
    SELECT choice.image
    FROM customization_step_choices choice
    JOIN customization_steps step ON step.id = choice.step_id
    WHERE choice.id = ? AND step.shop_id = ? AND choice.image IS NOT NULL
  `, [choiceId, shopId]);

  await queryRows(connection, `
    DELETE FROM product_customization_step_choices
    WHERE step_choice_id = ?
  `, [choiceId]);
  const result = await queryRows(connection, `
    DELETE FROM customization_step_choices
    WHERE id = ? AND step_id IN (
      SELECT id FROM customization_steps WHERE shop_id = ?
    )
  `, [choiceId, shopId]);

  return {
    affectedRows: result.affectedRows,
    images: imageRows.map(({ image }) => image).filter(Boolean),
  };
};

const deleteCustomizationChoicePermanently = ({
  shopId,
  choiceId,
  connection,
}) => {
  if (connection) {
    return deleteCustomizationChoicePermanentlyInConnection({
      shopId,
      choiceId,
      connection,
    });
  }
  return withTransaction((transactionConnection) => (
    deleteCustomizationChoicePermanentlyInConnection({
      shopId,
      choiceId,
      connection: transactionConnection,
    })
  ));
};

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
      ORDER BY step.id
      FOR UPDATE
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
  append,
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

  let stepsToWrite = steps;
  let nextPosition = 0;
  const currentChoicesById = new Map();
  if (append) {
    const currentSteps = await queryRows(connection, `
      SELECT step_id, position FROM product_customization_steps
      WHERE product_id = ?
      ORDER BY position DESC
      FOR UPDATE
    `, [productId]);
    const attachedIds = new Set(currentSteps.map((step) => Number(step.step_id)));
    stepsToWrite = steps.filter((step) => !attachedIds.has(Number(step.step_id)));
    nextPosition = currentSteps.length ? Number(currentSteps[0].position) + 1 : 0;
  } else {
    const unchangedChoiceIds = steps.flatMap((step) => step.choices
      .filter((choice) => step.keep_choice_order === true || choice.keep_extra_price === true)
      .map((choice) => choice.step_choice_id));
    if (unchangedChoiceIds.length > 0) {
      const currentChoices = await queryRows(connection, `
        SELECT product_choice.step_choice_id, product_choice.extra_price, product_choice.position
        FROM product_customization_step_choices product_choice
        JOIN product_customization_steps product_step
          ON product_step.id = product_choice.product_customization_step_id
        WHERE product_step.product_id = ? AND product_choice.step_choice_id IN (?)
        FOR UPDATE
      `, [productId, unchangedChoiceIds]);
      for (const choice of currentChoices) {
        currentChoicesById.set(Number(choice.step_choice_id), choice);
      }
    }
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
  }

  for (const [stepIndex, step] of stepsToWrite.entries()) {
    const stepResult = await queryRows(connection, `
      INSERT INTO product_customization_steps (
        product_id, step_id, position, minimum_choices, maximum_choices,
        active, created, updated
      ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NULL)
    `, [
      productId,
      step.step_id,
      append || step.position == null ? nextPosition + stepIndex : step.position,
      step.minimum_choices,
      step.maximum_choices,
      isDisabled(step.active) ? 0 : 1,
    ]);
    for (let choiceIndex = 0; choiceIndex < step.choices.length; choiceIndex += 1) {
      const choice = step.choices[choiceIndex];
      const currentChoice = currentChoicesById.get(Number(choice.step_choice_id));
      const price = choice.keep_extra_price === true && currentChoice
        ? currentChoice.extra_price
        : choice.extra_price;
      const position = step.keep_choice_order === true && currentChoice
        ? currentChoice.position
        : choice.position;
      await queryRows(connection, `
        INSERT INTO product_customization_step_choices (
          product_customization_step_id, step_choice_id, extra_price,
          position, active
        ) VALUES (?, ?, ?, ?, ?)
      `, [
        stepResult.insertId,
        choice.step_choice_id,
        price == null ? 0 : price,
        position == null ? choiceIndex : position,
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
  append = false,
  connection,
}) => {
  if (connection) {
    return replaceProductConfigurationInConnection({
      shopId,
      productId,
      steps,
      append,
      connection,
    });
  }
  return withTransaction((transactionConnection) => replaceProductConfigurationInConnection({
    shopId,
    productId,
    steps,
    append,
    connection: transactionConnection,
  }));
};

module.exports = {
  attachCustomizationStepToProducts,
  createCustomizationChoice,
  createCustomizationStep,
  deleteCustomizationChoice,
  deleteCustomizationChoicePermanently,
  deleteCustomizationStep,
  duplicateCustomizationStep,
  getCustomizationStep,
  getProductCustomizationState,
  getResolvedProductConfigurations,
  groupCustomizationStepRows,
  groupResolvedConfigurationRows,
  listCustomizationSteps,
  removeCustomizationStepFromProducts,
  replaceProductConfiguration,
  updateCustomizationChoice,
  updateCustomizationStep,
};
