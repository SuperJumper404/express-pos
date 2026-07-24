const pool = require("../src/config/dbPool");

const queries = {
  oldGroupCount: `
    SELECT COUNT(*) AS count
    FROM product_customization
  `,
  sharedStepCount: `
    SELECT COUNT(*) AS count
    FROM customization_steps
  `,
  productStepCount: `
    SELECT COUNT(*) AS count
    FROM product_customization_steps
  `,
  oldChoiceCount: `
    SELECT COUNT(*) AS count
    FROM product_choice
  `,
  sharedChoiceCount: `
    SELECT COUNT(*) AS count
    FROM customization_step_choices
  `,
  productStepChoiceCount: `
    SELECT COUNT(*) AS count
    FROM product_customization_step_choices
  `,
  activeOrderSnapshotCount: `
    SELECT COUNT(*) AS count
    FROM orderdetail_customization_snapshots
  `,
  invalidMinMaxCount: `
    SELECT COUNT(*) AS count
    FROM product_customization_steps
    WHERE minimum_choices < 0
       OR maximum_choices < minimum_choices
  `,
  missingProductAssociationCount: `
    SELECT COUNT(*) AS count
    FROM product_customization pc
    LEFT JOIN products p
      ON p.id = pc.product_id
    LEFT JOIN customization_steps cs
      ON cs.id = pc.id
      AND cs.shop_id = p.shopid
    LEFT JOIN product_customization_steps pcs
      ON pcs.id = pc.id
      AND pcs.product_id = pc.product_id
      AND pcs.step_id = pc.id
    WHERE p.id IS NULL
       OR cs.id IS NULL
       OR pcs.id IS NULL
  `,
  invalidChoiceAssociationCount: `
    SELECT COUNT(*) AS count
    FROM product_choice pc
    LEFT JOIN product_customization legacy_step
      ON legacy_step.id = pc.product_customization_id
    LEFT JOIN customization_step_choices csc
      ON csc.id = pc.id
      AND csc.step_id = pc.product_customization_id
    LEFT JOIN product_customization_step_choices pcsc
      ON pcsc.id = pc.id
      AND pcsc.product_customization_step_id = pc.product_customization_id
      AND pcsc.step_choice_id = pc.id
    WHERE legacy_step.id IS NULL
       OR csc.id IS NULL
       OR pcsc.id IS NULL
  `,
  unresolvedActiveOrderSelectionCount: `
    SELECT COUNT(*) AS count
    FROM orders_customization oc
    JOIN orders o
      ON o.id = oc.order_id
    LEFT JOIN orderdetail od
      ON od.id = oc.order_details_id
      AND od.orderid = oc.order_id
      AND od.productid = oc.product_id
    LEFT JOIN product_choice pc
      ON pc.id = oc.product_choice_id
    LEFT JOIN product_customization_steps pcs
      ON pcs.id = pc.product_customization_id
      AND pcs.product_id = oc.product_id
    LEFT JOIN product_customization_step_choices pcsc
      ON pcsc.id = pc.id
      AND pcsc.product_customization_step_id = pcs.id
    LEFT JOIN orderdetail_customization_snapshots snapshots
      ON snapshots.orderdetail_id = oc.order_details_id
      AND snapshots.product_customization_step_id = pcs.id
      AND snapshots.product_customization_step_choice_id = pcsc.id
    WHERE od.id IS NULL
       OR pc.id IS NULL
       OR pcs.id IS NULL
       OR pcsc.id IS NULL
       OR snapshots.id IS NULL
  `,
  legacySelectionWithoutActiveOrderCount: `
    SELECT COUNT(*) AS count
    FROM orders_customization oc
    LEFT JOIN orders o
      ON o.id = oc.order_id
    WHERE o.id IS NULL
  `,
};

const readCount = async (sql) => {
  const [rows] = await pool.query(sql);
  return Number(rows[0].count);
};

const delta = (oldCount, newCount) => newCount - oldCount;

const run = async () => {
  const entries = await Promise.all(
    Object.entries(queries).map(async ([name, sql]) => [name, await readCount(sql)]),
  );
  const counts = Object.fromEntries(entries);

  console.log(
    `Groups: old=${counts.oldGroupCount}, shared=${counts.sharedStepCount} ` +
      `(delta=${delta(counts.oldGroupCount, counts.sharedStepCount)}), ` +
      `product=${counts.productStepCount} ` +
      `(delta=${delta(counts.oldGroupCount, counts.productStepCount)})`,
  );
  console.log(
    `Choices: old=${counts.oldChoiceCount}, shared=${counts.sharedChoiceCount} ` +
      `(delta=${delta(counts.oldChoiceCount, counts.sharedChoiceCount)}), ` +
      `product=${counts.productStepChoiceCount} ` +
      `(delta=${delta(counts.oldChoiceCount, counts.productStepChoiceCount)})`,
  );
  console.log(`Active-order snapshots: ${counts.activeOrderSnapshotCount}`);
  console.log(`Invalid min/max rows: ${counts.invalidMinMaxCount}`);
  console.log(
    `Missing product associations: ${counts.missingProductAssociationCount}`,
  );
  console.log(
    `Invalid choice associations: ${counts.invalidChoiceAssociationCount}`,
  );
  console.log(
    `Unresolved active-order selections: ` +
      `${counts.unresolvedActiveOrderSelectionCount}`,
  );
  console.log(
    `Unresolved archive selections: ` +
      `${counts.legacySelectionWithoutActiveOrderCount} ` +
      "(informational; includes legacy selections without an active order, " +
      "and archive snapshots were not synthesized)",
  );

  const failures = [];
  if (
    counts.oldGroupCount !== counts.sharedStepCount ||
    counts.oldGroupCount !== counts.productStepCount
  ) {
    failures.push("group counts differ");
  }
  if (
    counts.oldChoiceCount !== counts.sharedChoiceCount ||
    counts.oldChoiceCount !== counts.productStepChoiceCount
  ) {
    failures.push("choice counts differ");
  }
  if (counts.invalidMinMaxCount > 0) {
    failures.push("invalid min/max rows exist");
  }
  if (counts.missingProductAssociationCount > 0) {
    failures.push("missing product associations exist");
  }
  if (counts.invalidChoiceAssociationCount > 0) {
    failures.push("invalid choice associations exist");
  }
  if (counts.unresolvedActiveOrderSelectionCount > 0) {
    failures.push("unresolved active-order selections exist");
  }

  if (failures.length > 0) {
    console.error(`Customization V2 verification failed: ${failures.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log("Customization V2 verification passed");
  }
};

run()
  .catch((error) => {
    console.error("Customization V2 verification could not run:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
