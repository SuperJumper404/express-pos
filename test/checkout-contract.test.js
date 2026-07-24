const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");

const routerSource = fs.readFileSync(
  require.resolve("../src/routers/r_customizations"),
  "utf8",
);
const uploadSource = fs.readFileSync(
  require.resolve("../src/helpers/middleware/customizationChoiceImages"),
  "utf8",
);
const indexSource = fs.readFileSync(require.resolve("../index"), "utf8");
for (const route of [
  '"/customization-steps"',
  '"/customization-steps/:id"',
  '"/customization-steps/:id/choices"',
  '"/customization-choices/:id"',
]) assert.ok(routerSource.includes(route), route);
for (const policy of [
  "5 * 1024 * 1024",
  '"image/jpeg"',
  '"image/png"',
  '"image/webp"',
]) assert.ok(uploadSource.includes(policy), policy);
assert.ok(uploadSource.includes("randomBytes"));
assert.ok(!uploadSource.includes("originalname"));
for (const protectedRead of [
  /\.get\("\/customization-steps", authentication,/,
  /\.get\("\/customization-steps\/:id", authentication,/,
]) assert.match(routerSource, protectedRead);
for (const adminWrite of [
  /\.post\("\/customization-steps", authentication, authAdmin,/,
  /\.patch\("\/customization-steps\/:id", authentication, authAdmin,/,
  /\.delete\("\/customization-steps\/:id", authentication, authAdmin,/,
  /\.post\([\s\S]*"\/customization-steps\/:id\/choices",[\s\S]*authentication,[\s\S]*authAdmin,/,
  /\.patch\([\s\S]*"\/customization-choices\/:id",[\s\S]*authentication,[\s\S]*authAdmin,/,
  /\.delete\("\/customization-choices\/:id", authentication, authAdmin,/,
]) assert.match(routerSource, adminWrite);
assert.ok(indexSource.includes('require("./src/routers/r_customizations")'));
assert.ok(indexSource.includes('path.join(envPUBLICIMAGEPATH, "customization-choices")'));
assert.ok(indexSource.includes('app.use(`${prefix}`, routerCustomizations)'));
assert.match(
  indexSource,
  /"\/api\/v1\/imgcustomizations"[\s\S]*express\.static\(customizationChoicesPath\)/,
);
const {
  createCustomizationChoice,
  createCustomizationStep,
  deleteCustomizationChoice,
  deleteCustomizationStep,
  getCustomizationStep,
  getProductCustomizationState,
  groupResolvedConfigurationRows,
  getResolvedProductConfigurations,
  listCustomizationSteps,
  replaceProductConfiguration,
  updateCustomizationChoice,
  updateCustomizationStep,
} = require("../src/modules/m_customizations");
const { buildCustomizationController } = require("../src/controllers/c_customizations");
const DomainError = require("../src/helpers/domainError");
const {
  buildCustomizationChoiceImageUpload,
} = require("../src/helpers/middleware/customizationChoiceImages");

const grouped = groupResolvedConfigurationRows([{
  product_id: 1,
  product_step_id: 10,
  step_id: 20,
  step_name: "Boissons",
  minimum_choices: 1,
  maximum_choices: 1,
  step_position: 2,
  product_step_choice_id: 30,
  step_choice_id: 40,
  choice_type: "simple",
  simple_name: "Eau",
  simple_image: "eau.webp",
  linked_name: null,
  linked_image: null,
  linked_stock: null,
  linked_archived: null,
  extra_price: "0.50",
  choice_position: 1,
  choice_active: 1,
}]);

assert.strictEqual(grouped.get(1)[0].choices[0].name, "Eau");
assert.strictEqual(grouped.get(1)[0].choices[0].available, true);

const unavailable = groupResolvedConfigurationRows([
  {
    product_id: 2,
    product_step_id: 11,
    step_id: 21,
    step_name: "Accompagnements",
    minimum_choices: 2,
    maximum_choices: 2,
    step_position: 1,
    product_step_active: 1,
    step_active: 1,
    product_step_choice_id: 31,
    step_choice_id: 41,
    choice_type: "linked_product",
    linked_product_id: 3,
    linked_name: "Frites",
    linked_image: "frites.webp",
    linked_stock: "5",
    linked_archived: "0",
    linked_is_hidden: 1,
    extra_price: "1.00",
    choice_position: 2,
    product_step_choice_active: 1,
    choice_active: 1,
  },
  {
    product_id: 2,
    product_step_id: 11,
    step_id: 21,
    step_name: "Accompagnements",
    minimum_choices: 2,
    maximum_choices: 2,
    step_position: 1,
    product_step_active: 1,
    step_active: 1,
    product_step_choice_id: 32,
    step_choice_id: 42,
    choice_type: "linked_product",
    linked_product_id: 4,
    linked_name: "Salade",
    linked_image: "salade.webp",
    linked_stock: 0,
    linked_archived: 0,
    linked_is_hidden: 0,
    extra_price: "0.00",
    choice_position: 1,
    product_step_choice_active: 1,
    choice_active: 1,
  },
  {
    product_id: 2,
    product_step_id: 11,
    step_id: 21,
    step_name: "Accompagnements",
    minimum_choices: 2,
    maximum_choices: 2,
    step_position: 1,
    product_step_active: 1,
    step_active: 1,
    product_step_choice_id: 33,
    step_choice_id: 43,
    choice_type: "linked_product",
    linked_product_id: 5,
    linked_name: "Potatoes",
    linked_image: "potatoes.webp",
    linked_stock: 5,
    linked_archived: 1,
    linked_is_hidden: 0,
    extra_price: "0.00",
    choice_position: 3,
    product_step_choice_active: 1,
    choice_active: 1,
  },
  {
    product_id: 2,
    product_step_id: 11,
    step_id: 21,
    step_name: "Accompagnements",
    minimum_choices: 2,
    maximum_choices: 2,
    step_position: 1,
    product_step_active: 1,
    step_active: 1,
    product_step_choice_id: 34,
    step_choice_id: 44,
    choice_type: "simple",
    simple_name: "Sans accompagnement",
    simple_image: null,
    extra_price: "0.00",
    choice_position: 4,
    product_step_choice_active: 0,
    choice_active: 1,
  },
]);
const unavailableSteps = unavailable.get(2);
assert.strictEqual(unavailableSteps[0].choices[1].name, "Frites");
assert.strictEqual(unavailableSteps[0].choices[1].available, true);
assert.strictEqual(
  unavailableSteps[0].choices.find((choice) => choice.product_step_choice_id === 33).available,
  false,
);
assert.strictEqual(
  unavailableSteps[0].choices.find((choice) => choice.product_step_choice_id === 34).available,
  false,
);
assert.strictEqual(unavailableSteps[0].available_choice_count, 1);
assert.strictEqual(unavailableSteps[0].available, false);
assert.strictEqual(unavailableSteps.customization_available, false);
assert.strictEqual(unavailableSteps.blocking_product_step_id, 11);
assert.deepStrictEqual(unavailableSteps.unavailable_reason, {
  code: "INSUFFICIENT_AVAILABLE_CHOICES",
  available_choice_count: 1,
  minimum_choices: 2,
});
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(getProductCustomizationState(unavailableSteps))),
  {
    customization_available: false,
    product_step_id: 11,
    reason: {
      code: "INSUFFICIENT_AVAILABLE_CHOICES",
      available_choice_count: 1,
      minimum_choices: 2,
    },
  },
);

const runRepositoryReadContracts = async () => {
  const resolvedCalls = [];
  const resolvedConnection = {
    query: async (sql, params) => {
      resolvedCalls.push({ sql, params });
      return [[{
        product_id: 8,
        product_step_id: 80,
        step_id: 81,
        step_name: "Sauces",
        minimum_choices: 0,
        maximum_choices: 2,
        step_position: 1,
        product_step_choice_id: null,
      }]];
    },
  };
  const resolved = await getResolvedProductConfigurations({
    shopId: 7,
    productIds: ["8", "9", 8],
    connection: resolvedConnection,
  });
  assert.strictEqual(resolvedCalls.length, 1);
  assert.match(resolvedCalls[0].sql, /p\.id IN \(\?\)/);
  assert.match(resolvedCalls[0].sql, /LEFT JOIN customization_step_choices/);
  assert.match(resolvedCalls[0].sql, /LEFT JOIN products linked_product/);
  assert.deepStrictEqual(resolvedCalls[0].params, [7, ["8", "9"]]);
  assert.strictEqual(resolved.get("8")[0].name, "Sauces");
  assert.ok(!resolved.has(8));
  assert.deepStrictEqual(resolved.get("9"), []);
  assert.strictEqual(resolved.get("9").customization_available, true);

  const listCalls = [];
  const listed = await listCustomizationSteps(7, {
    query: async (sql, params) => {
      listCalls.push({ sql, params });
      return [[
        {
          step_id: 5,
          step_name: "Boissons",
          step_description: "Choisissez",
          step_active: 1,
          step_created: "created",
          step_updated: null,
          choice_id: 51,
          choice_type: "simple",
          simple_name: "Eau",
          simple_image: "eau.webp",
          linked_product_id: null,
          default_position: 2,
          choice_active: 1,
        },
      ]];
    },
  });
  assert.strictEqual(listCalls.length, 1);
  assert.deepStrictEqual(listCalls[0].params, [7]);
  assert.strictEqual(listed[0].choices[0].name, "Eau");

  const replacementCalls = [];
  const replacementConnection = {
    query: async (sql, params) => {
      replacementCalls.push({ sql, params });
      if (/SELECT p\.id[\s\S]*FROM products p/.test(sql)) return [[{ id: 100 }]];
      if (/SELECT step\.id[\s\S]*FROM customization_steps step/.test(sql)) {
        return [[{ id: 20 }]];
      }
      if (/SELECT[\s\S]*choice\.id[\s\S]*FROM customization_step_choices choice/.test(sql)) {
        return [[{
          id: 40,
          step_id: 20,
          choice_type: "simple",
          linked_product_id: null,
          linked_shop_id: null,
        }]];
      }
      if (/INSERT INTO product_customization_steps/.test(sql)) {
        return [{ insertId: 200 }];
      }
      return [{ affectedRows: 1 }];
    },
  };
  await replaceProductConfiguration({
    shopId: 7,
    productId: 100,
    steps: [{
      step_id: 20,
      position: 1,
      minimum_choices: 1,
      maximum_choices: 1,
      active: true,
      choices: [{
        step_choice_id: 40,
        extra_price: "0.50",
        position: 1,
        active: true,
      }],
    }],
    connection: replacementConnection,
  });
  const firstDelete = replacementCalls.findIndex(({ sql }) => /DELETE FROM/.test(sql));
  assert.ok(firstDelete >= 3, "all ownership reads happen before replacement");
  assert.match(replacementCalls[firstDelete].sql, /product_customization_step_choices/);
  assert.ok(replacementCalls.some(({ sql, params }) => (
    /INSERT INTO product_customization_step_choices/.test(sql)
      && params[1] === 40
  )));

  const baseStep = {
    step_id: 20,
    minimum_choices: 1,
    maximum_choices: 1,
    choices: [{ step_choice_id: 40 }],
  };
  const nullStepIdCalls = [];
  const nullStepIdConnection = {
    query: async (sql) => {
      nullStepIdCalls.push(sql);
      if (/FROM products p/.test(sql)) return [[{ id: 100 }]];
      if (/FROM customization_steps step/.test(sql)) return [[{ id: 20 }]];
      if (/INSERT INTO product_customization_steps/.test(sql)) return [{ insertId: 200 }];
      return [{ affectedRows: 1 }];
    },
  };
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [{
        step_id: null,
        minimum_choices: 0,
        maximum_choices: 1,
        choices: [],
      }],
      connection: nullStepIdConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_STEP_ID_INVALID"
      && Object.prototype.hasOwnProperty.call(error, "step_id")
      && error.step_id === null,
  );
  assert.ok(!nullStepIdCalls.some((sql) => /DELETE FROM/.test(sql)));
  const nullChoiceIdCalls = [];
  const nullChoiceIdConnection = {
    query: async (sql) => {
      nullChoiceIdCalls.push(sql);
      if (/FROM products p/.test(sql)) return [[{ id: 100 }]];
      if (/FROM customization_steps step/.test(sql)) return [[{ id: 20 }]];
      if (/FROM customization_step_choices choice/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [{
        step_id: 20,
        minimum_choices: 0,
        maximum_choices: 1,
        choices: [{ step_choice_id: null }],
      }],
      connection: nullChoiceIdConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_CHOICE_ID_INVALID"
      && Object.prototype.hasOwnProperty.call(error, "choice_id")
      && error.choice_id === null
      && error.step_id === 20,
  );
  assert.ok(!nullChoiceIdCalls.some((sql) => /DELETE FROM/.test(sql)));
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep, { ...baseStep, choices: [] }],
      connection: replacementConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_STEP_DUPLICATE",
  );
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [{ ...baseStep, choices: [{ step_choice_id: 40 }, { step_choice_id: 40 }] }],
      connection: replacementConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_CHOICE_DUPLICATE",
  );
  for (const invalidLimits of [
    { minimum_choices: -1, maximum_choices: 1 },
    { minimum_choices: 0, maximum_choices: 0 },
    { minimum_choices: 2, maximum_choices: 1 },
  ]) {
    await assert.rejects(
      () => replaceProductConfiguration({
        shopId: 7,
        productId: 100,
        steps: [{ ...baseStep, ...invalidLimits }],
        connection: replacementConnection,
      }),
      (error) => error.code === "CUSTOMIZATION_LIMITS_INVALID",
    );
  }

  const ownershipConnection = ({ stepRows, choiceRows }) => {
    const calls = [];
    return {
      calls,
      query: async (sql) => {
        calls.push(sql);
        if (/FROM products p/.test(sql)) return [[{ id: 100 }]];
        if (/FROM customization_steps step/.test(sql)) return [stepRows];
        if (/FROM customization_step_choices choice/.test(sql)) return [choiceRows];
        throw new Error("replacement mutated before full validation");
      },
    };
  };
  const foreignStepConnection = ownershipConnection({ stepRows: [], choiceRows: [] });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep],
      connection: foreignStepConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_STEP_NOT_OWNED",
  );
  assert.ok(!foreignStepConnection.calls.some((sql) => /DELETE FROM/.test(sql)));

  const wrongStepConnection = ownershipConnection({
    stepRows: [{ id: 20 }],
    choiceRows: [{
      id: 40,
      step_id: 99,
      choice_type: "simple",
      linked_product_id: null,
      linked_shop_id: null,
    }],
  });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep],
      connection: wrongStepConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_CHOICE_STEP_MISMATCH",
  );

  const selfLinkConnection = ownershipConnection({
    stepRows: [{ id: 20 }],
    choiceRows: [{
      id: 40,
      step_id: 20,
      choice_type: "linked_product",
      linked_product_id: 100,
      linked_shop_id: 7,
    }],
  });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep],
      connection: selfLinkConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_PARENT_SELF_LINK",
  );
  assert.ok(!selfLinkConnection.calls.some((sql) => /DELETE FROM/.test(sql)));

  const stringSelfLinkConnection = ownershipConnection({
    stepRows: [{ id: 20 }],
    choiceRows: [{
      id: 40,
      step_id: 20,
      choice_type: "linked_product",
      linked_product_id: 100,
      linked_shop_id: 7,
    }],
  });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: "7",
      productId: "100",
      steps: [{
        ...baseStep,
        step_id: "20",
        choices: [{ step_choice_id: "40" }],
      }],
      connection: stringSelfLinkConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_PARENT_SELF_LINK",
  );

  const foreignLinkConnection = ownershipConnection({
    stepRows: [{ id: 20 }],
    choiceRows: [{
      id: 40,
      step_id: 20,
      choice_type: "linked_product",
      linked_product_id: 200,
      linked_shop_id: 8,
    }],
  });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep],
      connection: foreignLinkConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_LINKED_PRODUCT_NOT_OWNED",
  );

  const crudCalls = [];
  const crudConnection = {
    query: async (sql, params) => {
      crudCalls.push({ sql, params });
      if (/SELECT[\s\S]*FROM customization_steps step[\s\S]*step\.id = \?/.test(sql)) {
        return [[{
          step_id: 20,
          step_name: "Boissons",
          step_description: null,
          step_active: 1,
          choice_id: null,
        }]];
      }
      if (/SELECT[\s\S]*FROM customization_step_choices choice/.test(sql)) {
        return [[{
          id: 40,
          step_id: 20,
          choice_type: "simple",
          name: "Eau",
          image: "old.webp",
          linked_product_id: null,
          default_position: 1,
          active: 1,
        }]];
      }
      if (/SELECT step\.id FROM customization_steps step/.test(sql)) return [[{ id: 20 }]];
      if (/INSERT INTO customization_steps/.test(sql)) return [{ insertId: 20 }];
      if (/INSERT INTO customization_step_choices/.test(sql)) return [{ insertId: 40 }];
      return [{ affectedRows: 1 }];
    },
  };
  assert.strictEqual((await getCustomizationStep({
    shopId: 7,
    stepId: 20,
    connection: crudConnection,
  })).name, "Boissons");
  assert.strictEqual((await createCustomizationStep({
    shopId: 7,
    data: { name: "Desserts", description: "Optionnel", active: "false" },
    connection: crudConnection,
  })).insertId, 20);
  await updateCustomizationStep({
    shopId: 7,
    stepId: 20,
    data: { name: "Boissons froides", active: "false" },
    connection: crudConnection,
  });
  await deleteCustomizationStep({ shopId: 7, stepId: 20, connection: crudConnection });
  assert.strictEqual((await createCustomizationChoice({
    shopId: 7,
    stepId: 20,
    data: {
      choice_type: "simple",
      name: "Eau",
      image: "eau.webp",
      default_position: 1,
      active: "false",
    },
    connection: crudConnection,
  })).insertId, 40);
  await updateCustomizationChoice({
    shopId: 7,
    choiceId: 40,
    data: { name: "Eau plate", image: "eau-plate.webp", active: "false" },
    connection: crudConnection,
  });
  await deleteCustomizationChoice({ shopId: 7, choiceId: 40, connection: crudConnection });
  assert.ok(crudCalls.every(({ sql }) => !/\$\{|shopId|stepId|choiceId/.test(sql)));
  assert.ok(crudCalls.some(({ sql, params }) => (
    /UPDATE customization_steps/.test(sql) && params.includes(7)
  )));
  assert.ok(crudCalls.some(({ sql, params }) => (
    /UPDATE customization_step_choices choice/.test(sql) && params.includes(7)
  )));
  assert.strictEqual(
    crudCalls.find(({ sql }) => /INSERT INTO customization_steps/.test(sql)).params[3],
    0,
  );
  assert.strictEqual(
    crudCalls.find(({ sql }) => /INSERT INTO customization_step_choices/.test(sql)).params[6],
    0,
  );
  assert.ok(require("../package.json").scripts.test.includes("checkout-contract.test.js"));
};

const makeResponse = () => ({
  statusCode: null,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

const runUploadMiddlewareContracts = async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "customization-upload-"));
  const destination = path.join(temporaryRoot, "customization-choices");
  fs.mkdirSync(destination);
  const app = express();
  app.post(
    "/upload",
    buildCustomizationChoiceImageUpload({ destination }),
    (req, res) => res.status(204).end(),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const upload = async ({ bytes, type, name }) => {
    const form = new FormData();
    form.append("image", new Blob([bytes], { type }), name);
    return fetch(`http://127.0.0.1:${port}/upload`, { method: "POST", body: form });
  };
  const storedFiles = () => fs.readdirSync(destination);
  const clearStoredFiles = () => {
    for (const filename of storedFiles()) fs.unlinkSync(path.join(destination, filename));
  };

  try {
    const allowed = [
      {
        type: "image/jpeg",
        name: "client-name.jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
        extension: ".jpg",
      },
      {
        type: "image/png",
        name: "client-name.png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        extension: ".png",
      },
      {
        type: "image/webp",
        name: "client-name.webp",
        bytes: Buffer.from("RIFF0000WEBP", "ascii"),
        extension: ".webp",
      },
    ];
    for (const fixture of allowed) {
      const response = await upload(fixture);
      assert.strictEqual(response.status, 204, fixture.type);
    }
    const generatedFiles = storedFiles();
    assert.strictEqual(generatedFiles.length, 3);
    for (const fixture of allowed) {
      assert.ok(generatedFiles.some((filename) => filename.endsWith(fixture.extension)));
      assert.ok(!generatedFiles.includes(fixture.name));
    }
    clearStoredFiles();

    const exactLimit = Buffer.alloc(5 * 1024 * 1024);
    allowed[1].bytes.copy(exactLimit, 0, 0, allowed[1].bytes.length);
    let response = await upload({
      bytes: exactLimit,
      type: "image/png",
      name: "exact-limit.png",
    });
    assert.strictEqual(response.status, 204);
    assert.strictEqual(storedFiles().length, 1);
    clearStoredFiles();

    const overLimit = Buffer.alloc((5 * 1024 * 1024) + 1);
    allowed[1].bytes.copy(overLimit, 0, 0, allowed[1].bytes.length);
    response = await upload({
      bytes: overLimit,
      type: "image/png",
      name: "over-limit.png",
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(
      (await response.json()).message,
      "Le fichier dépasse la limite de 5 Mo.",
    );
    assert.deepStrictEqual(storedFiles(), []);

    response = await upload({
      bytes: Buffer.from("plain text"),
      type: "text/plain",
      name: "not-an-image.txt",
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual((await response.json()).message, "Type de fichier non autorisé.");
    assert.deepStrictEqual(storedFiles(), []);

    response = await upload({
      bytes: Buffer.from("not really a jpeg"),
      type: "image/jpeg",
      name: "spoofed.jpg",
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual((await response.json()).message, "Type de fichier non autorisé.");
    assert.deepStrictEqual(storedFiles(), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

const runCustomizationApiContracts = async () => {
  const unexpected = async () => {
    throw new Error("unexpected catalog call");
  };
  const catalogDefaults = {
    createCustomizationChoice: unexpected,
    createCustomizationStep: unexpected,
    deleteCustomizationChoice: unexpected,
    deleteCustomizationStep: unexpected,
    getCustomizationStep: unexpected,
    listCustomizationSteps: unexpected,
    updateCustomizationChoice: unexpected,
    updateCustomizationStep: unexpected,
  };
  const makeController = (catalog, removed = [], logs = []) => buildCustomizationController({
    catalog: { ...catalogDefaults, ...catalog },
    fileSystem: {
      existsSync: () => true,
      unlinkSync: (filePath) => removed.push(filePath),
    },
    logger: { error: (...args) => logs.push(args) },
    publicImagePath: "C:\\public-images",
  });

  const listCalls = [];
  let handlers = makeController({
    listCustomizationSteps: async (shopId) => {
      listCalls.push(shopId);
      return [{ id: 1, name: "Boissons" }];
    },
  });
  let res = makeResponse();
  await handlers.listCustomizationSteps({ shopid: 7 }, res);
  assert.deepStrictEqual(listCalls, [7]);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.payload.data[0].name, "Boissons");

  let stepCreateCalls = 0;
  handlers = makeController({
    createCustomizationStep: async () => {
      stepCreateCalls += 1;
    },
  });
  res = makeResponse();
  await handlers.createCustomizationStep({ shopid: 7, body: { name: "   " } }, res);
  assert.strictEqual(stepCreateCalls, 0);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(res.payload.data.code, "CUSTOMIZATION_STEP_NAME_REQUIRED");

  let choiceCreateCalls = 0;
  const rejectedUploadRemovals = [];
  handlers = makeController({
    createCustomizationChoice: async () => {
      choiceCreateCalls += 1;
    },
  }, rejectedUploadRemovals);
  res = makeResponse();
  await handlers.createCustomizationChoice({
    shopid: 7,
    params: { id: "20" },
    body: { choice_type: "simple", name: "\t" },
    file: { filename: "new.webp" },
  }, res);
  assert.strictEqual(choiceCreateCalls, 0);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(res.payload.data.code, "CUSTOMIZATION_CHOICE_NAME_REQUIRED");
  assert.deepStrictEqual(rejectedUploadRemovals, [
    "C:\\public-images\\customization-choices\\new.webp",
  ]);

  res = makeResponse();
  await handlers.createCustomizationChoice({
    shopid: 7,
    params: { id: "20" },
    body: { choice_type: "linked_product", linked_product_id: "42" },
    file: { filename: "unused.png" },
  }, res);
  assert.strictEqual(choiceCreateCalls, 0);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(res.payload.data.code, "CUSTOMIZATION_LINKED_PRODUCT_IMAGE_NOT_ALLOWED");
  assert.ok(rejectedUploadRemovals.some((filePath) => filePath.endsWith("unused.png")));

  const createCalls = [];
  handlers = makeController({
    createCustomizationChoice: async (args) => {
      createCalls.push(args);
      return { insertId: 51 };
    },
  });
  res = makeResponse();
  await handlers.createCustomizationChoice({
    shopid: 7,
    params: { id: "20" },
    body: { choice_type: "simple", name: "Eau" },
    file: { filename: "generated.webp" },
  }, res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(createCalls[0].shopId, 7);
  assert.strictEqual(createCalls[0].stepId, "20");
  assert.strictEqual(createCalls[0].data.image, "generated.webp");

  const sqlFailureRemovals = [];
  handlers = makeController({
    createCustomizationChoice: async () => {
      throw new DomainError(
        422,
        "CUSTOMIZATION_CHOICE_DUPLICATE",
        "duplicate",
        { product_id: 8, product_step_id: 80, choice_id: 40 },
      );
    },
  }, sqlFailureRemovals);
  res = makeResponse();
  await handlers.createCustomizationChoice({
    shopid: 7,
    params: { id: "20" },
    body: { choice_type: "simple", name: "Eau" },
    file: { filename: "failed.webp" },
  }, res);
  assert.strictEqual(res.statusCode, 422);
  assert.deepStrictEqual(res.payload.data, {
    code: "CUSTOMIZATION_CHOICE_DUPLICATE",
    product_id: 8,
    product_step_id: 80,
    choice_id: 40,
  });
  assert.ok(sqlFailureRemovals.some((filePath) => filePath.endsWith("failed.webp")));

  const responseFailureRemovals = [];
  handlers = makeController({
    createCustomizationChoice: async () => ({ insertId: 52 }),
  }, responseFailureRemovals);
  const brokenResponse = {
    status() {
      return this;
    },
    json() {
      throw new Error("socket closed");
    },
  };
  await assert.rejects(
    () => handlers.createCustomizationChoice({
      shopid: 7,
      params: { id: "20" },
      body: { choice_type: "simple", name: "Eau" },
      file: { filename: "committed.webp" },
    }, brokenResponse),
    /socket closed/,
  );
  assert.deepStrictEqual(responseFailureRemovals, []);

  const replacementCalls = [];
  const replacementRemovals = [];
  handlers = makeController({
    listCustomizationSteps: async (shopId) => {
      replacementCalls.push(["list", shopId]);
      return [{ choices: [{ id: 40, choice_type: "simple", image: "old.jpg" }] }];
    },
    updateCustomizationChoice: async (args) => {
      replacementCalls.push(["update", args]);
      return { affectedRows: 1 };
    },
  }, replacementRemovals);
  res = makeResponse();
  await handlers.updateCustomizationChoice({
    shopid: 7,
    params: { id: "40" },
    body: { name: "Eau plate" },
    file: { filename: "replacement.webp" },
  }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(replacementCalls[0][1], 7);
  assert.strictEqual(replacementCalls[1][1].shopId, 7);
  assert.strictEqual(replacementCalls[1][1].data.image, "replacement.webp");
  assert.deepStrictEqual(replacementRemovals, [
    "C:\\public-images\\customization-choices\\old.jpg",
  ]);

  const linkedConversionRemovals = [];
  handlers = makeController({
    listCustomizationSteps: async () => ([{
      choices: [{
        id: 40,
        choice_type: "linked_product",
        image: "inherited-product-image.jpg",
      }],
    }]),
    updateCustomizationChoice: async () => ({ affectedRows: 1 }),
  }, linkedConversionRemovals);
  res = makeResponse();
  await handlers.updateCustomizationChoice({
    shopid: 7,
    params: { id: "40" },
    body: { choice_type: "simple", name: "Option autonome" },
    file: { filename: "owned-simple-image.webp" },
  }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(linkedConversionRemovals, []);

  let partialChoiceUpdateCalls = 0;
  handlers = makeController({
    updateCustomizationChoice: async ({ data }) => {
      partialChoiceUpdateCalls += 1;
      assert.strictEqual(data.choice_type, "simple");
      assert.ok(!Object.prototype.hasOwnProperty.call(data, "name"));
      return { affectedRows: 1 };
    },
  });
  res = makeResponse();
  await handlers.updateCustomizationChoice({
    shopid: 7,
    params: { id: "40" },
    body: { choice_type: "simple" },
  }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(partialChoiceUpdateCalls, 1);

  const failedReplacementRemovals = [];
  const unexpectedErrorLogs = [];
  handlers = makeController({
    listCustomizationSteps: async () => ([{
      choices: [{ id: 40, choice_type: "simple", image: "old.jpg" }],
    }]),
    updateCustomizationChoice: async () => {
      const error = new Error("sql failure: table customization_step_choices missing");
      error.code = "ER_NO_SUCH_TABLE";
      throw error;
    },
  }, failedReplacementRemovals, unexpectedErrorLogs);
  res = makeResponse();
  await handlers.updateCustomizationChoice({
    shopid: 7,
    params: { id: "40" },
    body: { name: "Eau" },
    file: { filename: "new-on-failure.webp" },
  }, res);
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.payload.message, "Erreur serveur.");
  assert.deepStrictEqual(res.payload.data, {
    code: "INTERNAL_ERROR",
    product_id: null,
    product_step_id: null,
    choice_id: null,
  });
  assert.ok(!JSON.stringify(res.payload).includes("sql failure"));
  assert.ok(!JSON.stringify(res.payload).includes("ER_NO_SUCH_TABLE"));
  assert.strictEqual(unexpectedErrorLogs.length, 1);
  assert.deepStrictEqual(failedReplacementRemovals, [
    "C:\\public-images\\customization-choices\\new-on-failure.webp",
  ]);

  for (const [handlerName, catalogName, code] of [
    ["updateCustomizationStep", "updateCustomizationStep", "CUSTOMIZATION_STEP_NOT_FOUND"],
    ["deleteCustomizationStep", "deleteCustomizationStep", "CUSTOMIZATION_STEP_NOT_FOUND"],
    ["updateCustomizationChoice", "updateCustomizationChoice", "CUSTOMIZATION_CHOICE_NOT_FOUND"],
    ["deleteCustomizationChoice", "deleteCustomizationChoice", "CUSTOMIZATION_CHOICE_NOT_FOUND"],
  ]) {
    handlers = makeController({ [catalogName]: async () => ({ affectedRows: 0 }) });
    res = makeResponse();
    await handlers[handlerName]({
      shopid: 7,
      params: { id: "999" },
      body: handlerName.includes("Step") ? { name: "Valid" } : { name: "Valid" },
    }, res);
    assert.strictEqual(res.statusCode, 404, handlerName);
    assert.strictEqual(res.payload.data.code, code, handlerName);
  }

  const deleteRemovals = [];
  handlers = makeController({
    deleteCustomizationChoice: async ({ shopId, choiceId }) => {
      assert.strictEqual(shopId, 7);
      assert.strictEqual(choiceId, "40");
      return { affectedRows: 1 };
    },
  }, deleteRemovals);
  res = makeResponse();
  await handlers.deleteCustomizationChoice({ shopid: 7, params: { id: "40" } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(deleteRemovals, []);

  const traversalRemovals = [];
  handlers = makeController({
    listCustomizationSteps: async () => ([{
      choices: [{ id: 40, choice_type: "simple", image: "../outside.webp" }],
    }]),
    updateCustomizationChoice: async () => ({ affectedRows: 1 }),
  }, traversalRemovals);
  res = makeResponse();
  await handlers.updateCustomizationChoice({
    shopid: 7,
    params: { id: "40" },
    body: { name: "Eau" },
    file: { filename: "safe.webp" },
  }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(traversalRemovals, []);
};

runRepositoryReadContracts()
  .then(runUploadMiddlewareContracts)
  .then(runCustomizationApiContracts)
  .then(() => console.log("customization catalog contracts passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
