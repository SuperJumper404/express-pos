const crypto = require("crypto");
const DomainError = require("../helpers/domainError");
const { withTransaction } = require("../helpers/withTransaction");
const { isCourier, isDeliveryOperator, forbidden } = require("../helpers/deliveryAuthorization");

const invalid = () => new DomainError(400, "DELIVERY_REQUEST_INVALID", "Invalid courier cash request");
const conflict = (code = "COURIER_CASH_CONFLICT") => new DomainError(409, code, "Courier cash conflicts with current state");
const json = value => typeof value === "string" ? JSON.parse(value) : value;
const cents = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new DomainError(422, "DELIVERY_MONEY_INVALID", "Invalid cash amount");
  return number;
};
const sum = values => values.reduce((total, value) => cents(total + cents(value)), 0);
const holderId = value => {
  if (!/^[1-9]\d{0,9}$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw invalid();
  return Number(value);
};
const journalId = value => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
const explicitTime = value => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid cash posting time");
  return date.toISOString().replace("T", " ").replace("Z", "000");
};
const query = async (connection, sql, params = []) => (await connection.query(sql, params))[0];
const insertedId = async connection => (await query(connection, "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id"))[0].id;
const repository = {
  lockShop: async ({ shopId, connection }) => (await query(connection, "SELECT id FROM shop WHERE id = ? FOR UPDATE", [shopId]))[0],
  account: async ({ shopId, id, connection }) => (await query(connection,
    "SELECT id,shopid,access,status,module_permissions FROM users WHERE shopid=? AND id=? FOR UPDATE", [shopId, id]))[0],
  journal: async ({ shopId, courierId, closedAt, connection }) => {
    const params = [shopId];
    let where = "shopid=?";
    if (courierId !== undefined) { where += " AND courier_id=?"; params.push(courierId); }
    if (closedAt) { where += " AND created_at<=?"; params.push(closedAt); }
    const result = {};
    for (const [key, table] of [["collections", "delivery_payment_collections"], ["remittances", "courier_cash_remittances"],
      ["allocations", "courier_cash_remittance_allocations"], ["adjustments", "courier_cash_adjustments"]]) {
      const ids = key === "allocations" ? ",CAST(collection_id AS CHAR) collection_id,CAST(remittance_id AS CHAR) remittance_id" :
        key === "adjustments" ? ",CAST(collection_id AS CHAR) collection_id,CAST(remittance_id AS CHAR) remittance_id" : "";
      result[key] = await query(connection, `SELECT *,CAST(id AS CHAR) id${ids},
        DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') created_at FROM ${table}
        WHERE ${where}${key === "collections" ? " AND method='cash'" : ""} ORDER BY created_at,${table}.id`, params);
    }
    return result;
  },
  replay: async ({ table, shopId, idempotencyKey, connection }) => (await query(connection,
    `SELECT CAST(id AS CHAR) id,request_hash,result FROM ${table} WHERE shopid=? AND idempotency_key=?`, [shopId, idempotencyKey]))[0],
  postingTime: async ({ connection }) => (await query(connection,
    "SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') now"))[0].now,
  appendRemittance: async ({ row, connection }) => {
    await query(connection, "INSERT INTO courier_cash_remittances SET ?", [row]);
    return insertedId(connection);
  },
  appendAllocation: ({ row, connection }) => query(connection, "INSERT INTO courier_cash_remittance_allocations SET ?", [row]),
  appendAdjustment: async ({ row, connection }) => {
    await query(connection, "INSERT INTO courier_cash_adjustments SET ?", [row]);
    return insertedId(connection);
  },
};

// Corrections carry their exact source applications; no mutable debt or refund
// status is inferred from an order, assignment or the holder's current role.
const cashState = journal => {
  const collections = journal.collections.map(row => ({ ...row, due: cents(row.amount_cents), allocated: 0 }));
  const byId = new Map(collections.map(row => [row.id, row]));
  for (const row of journal.allocations) {
    const source = byId.get(row.collection_id);
    if (!source) throw new Error("Missing cash allocation source");
    source.allocated = cents(source.allocated + cents(row.amount_cents));
    source.due = cents(source.due - cents(row.amount_cents));
  }
  for (const row of journal.adjustments) {
    const result = json(row.result);
    if (!result || !Array.isArray(result.applications) || sum(result.applications.map(item => item.deltaDueCents)) !== cents(row.delta_due_cents)) {
      throw new Error("Missing cash correction applications");
    }
    for (const item of result.applications) {
      const source = byId.get(item.collectionId);
      if (!source) throw new Error("Missing cash correction source");
      source.due = cents(source.due + item.deltaDueCents);
    }
  }
  for (const row of collections) {
    if (row.due < 0 || row.due > cents(row.amount_cents) - row.allocated) throw new Error("Invalid cash custody balance");
  }
  return { ...journal, collections };
};
const balanceView = (state, shopId, courierId) => ({
  shopId, courierId,
  version: 1 + state.collections.length + state.remittances.length + state.adjustments.length,
  collectedCents: sum(state.collections.map(row => row.amount_cents)),
  receivedCents: sum(state.remittances.map(row => row.received_cents)),
  remainingDueCents: sum(state.collections.map(row => row.due)),
  discrepancyCents: sum(state.remittances.map(row => row.discrepancy_cents)),
  surplusCents: sum(state.remittances.map(row => Math.max(0, cents(row.discrepancy_cents)))),
  adjustedDueCents: sum(state.adjustments.map(row => row.delta_due_cents)),
  collections: state.collections.map(row => ({ collectionId: row.id, paymentId: row.payment_id,
    collectedCents: cents(row.amount_cents), allocatedCents: row.allocated, remainingDueCents: row.due, createdAt: row.created_at })),
  remittances: state.remittances.map(row => ({ remittanceId: row.id, cashierId: row.cashier_id,
    expectedCents: cents(row.expected_cents), receivedCents: cents(row.received_cents), discrepancyCents: cents(row.discrepancy_cents), createdAt: row.created_at })),
  adjustments: state.adjustments.map(row => ({ adjustmentId: row.id, collectionId: row.collection_id,
    remittanceId: row.remittance_id, deltaDueCents: cents(row.delta_due_cents), actorId: row.actor_id, reason: row.reason, createdAt: row.created_at })),
});

const buildCourierCash = ({ repository: supplied = {}, runInTransaction = withTransaction, clock } = {}) => {
  const repo = { ...repository, ...supplied };
  const transact = async (input, operation, work) => {
    const allowed = operation === "balance" ? ["actor", "courierId"] : operation === "remit" ?
      ["actor", "courierId", "receivedCents", "expectedBalanceVersion", "idempotencyKey"] :
      ["actor", "courierId", "collectionId", "remittanceId", "deltaDueCents", "reason", "idempotencyKey"];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw invalid();
    const { actor, idempotencyKey } = input;
    const courierId = holderId(input.courierId);
    if (!actor || actor.subject !== "staff" || !actor.id || !actor.shopId) throw forbidden();
    if (operation !== "balance" && (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 191)) throw invalid();
    if (operation === "remit" && (!Number.isSafeInteger(input.receivedCents) || input.receivedCents < 0 ||
      !Number.isSafeInteger(input.expectedBalanceVersion) || input.expectedBalanceVersion < 1 || input.expectedBalanceVersion > 4294967295)) throw invalid();
    if (operation === "adjust" && (!Number.isSafeInteger(input.deltaDueCents) || input.deltaDueCents === 0 ||
      typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 2000 ||
      (!journalId(input.collectionId) && !journalId(input.remittanceId)) ||
      (input.collectionId != null && !journalId(input.collectionId)) || (input.remittanceId != null && !journalId(input.remittanceId)))) throw invalid();
    try {
      return await runInTransaction(async connection => {
        if (!await repo.lockShop({ shopId: actor.shopId, connection })) throw forbidden();
        const accounts = new Map();
        for (const id of [...new Set([holderId(actor.id), courierId])].sort((a, b) => a - b)) {
          accounts.set(id, await repo.account({ shopId: actor.shopId, id, connection }));
        }
        const current = accounts.get(Number(actor.id));
        if (!current || current.access == null || Number(current.status) !== 1) throw forbidden();
        const effective = { subject: "staff", id: current.id, shopId: current.shopid, access: current.access, module_permissions: current.module_permissions };
        if (operation === "balance" ? !(isDeliveryOperator(effective) || (isCourier(effective) && Number(current.id) === courierId)) :
          !isDeliveryOperator(effective) || (operation === "adjust" && Number(current.access) !== 0)) throw forbidden();
        if (!accounts.get(courierId)) throw new DomainError(404, "COURIER_CASH_NOT_FOUND", "Cash holder not found");
        if (operation !== "balance" && Number(current.id) === courierId) throw forbidden();
        const hash = crypto.createHash("sha256").update(JSON.stringify({ operation, shopId: String(current.shopid), actorId: String(current.id),
          courierId, ...(operation === "remit" ? { receivedCents: input.receivedCents, expectedBalanceVersion: input.expectedBalanceVersion } :
            { collectionId: input.collectionId || null, remittanceId: input.remittanceId || null, deltaDueCents: input.deltaDueCents, reason: input.reason }) })).digest("hex");
        if (operation !== "balance") {
          const replay = await repo.replay({ table: operation === "remit" ? "courier_cash_remittances" : "courier_cash_adjustments",
            shopId: current.shopid, idempotencyKey, connection });
          if (replay) {
            if (replay.request_hash !== hash) throw conflict("DELIVERY_IDEMPOTENCY_CONFLICT");
            const response = json(replay.result).response;
            if (operation === "remit") return { remittanceId: replay.id, ...response };
            response.balance.adjustments[response.balance.adjustments.length - 1].adjustmentId = replay.id;
            return { adjustmentId: replay.id, ...response };
          }
          const reused = await repo.replay({ table: operation === "remit" ? "courier_cash_adjustments" : "courier_cash_remittances",
            shopId: current.shopid, idempotencyKey, connection });
          if (reused) throw conflict("DELIVERY_IDEMPOTENCY_CONFLICT");
        }
        const state = cashState(await repo.journal({ shopId: current.shopid, courierId, connection }));
        const balance = balanceView(state, current.shopid, courierId);
        const now = operation === "balance" ? null : clock ? explicitTime(await clock({ connection })) : await repo.postingTime({ connection });
        return work({ state, balance, now, hash, courierId, current, connection });
      });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") throw conflict("DELIVERY_IDEMPOTENCY_CONFLICT");
      throw error;
    }
  };
  const balance = input => transact(input, "balance", async ({ balance }) => balance);
  const remit = input => transact(input, "remit", async ({ state, balance, now, hash, courierId, current, connection }) => {
    if (balance.version !== input.expectedBalanceVersion) throw conflict("COURIER_CASH_VERSION_CONFLICT");
    const expectedCents = balance.remainingDueCents;
    if (expectedCents <= 0) throw conflict();
    const response = { expectedCents, receivedCents: input.receivedCents, discrepancyCents: input.receivedCents - expectedCents,
      remainingDueCents: Math.max(0, expectedCents - input.receivedCents) };
    // Keep the immutable result independent of AUTO_INCREMENT; replay projects
    // the exact ID from the journal row without an UPDATE after insertion.
    const remittanceId = await repo.appendRemittance({ connection, row: { shopid: current.shopid, courier_id: courierId, cashier_id: current.id,
      expected_cents: expectedCents, received_cents: input.receivedCents, discrepancy_cents: response.discrepancyCents,
      expected_balance_version: input.expectedBalanceVersion, idempotency_key: input.idempotencyKey, request_hash: hash,
      result: JSON.stringify({ response, sourceCollectionIds: state.collections.filter(row => row.due > 0).map(row => row.id) }), created_at: now } });
    let remaining = Math.min(input.receivedCents, expectedCents);
    for (const source of state.collections) {
      const amount = Math.min(remaining, source.due);
      if (amount > 0) await repo.appendAllocation({ connection, row: { shopid: current.shopid, courier_id: courierId,
        remittance_id: remittanceId, collection_id: source.id, amount_cents: amount, created_at: now } });
      remaining -= amount;
    }
    return { remittanceId, ...response };
  });
  const adjust = input => transact(input, "adjust", async ({ state, now, hash, courierId, current, connection }) => {
    const source = input.remittanceId && state.remittances.find(row => row.id === input.remittanceId);
    if ((input.remittanceId && !source) || (input.collectionId && !state.collections.some(row => row.id === input.collectionId))) throw conflict();
    const eligible = source ? json(source.result).sourceCollectionIds : null;
    const candidates = state.collections.filter(row => (!input.collectionId || row.id === input.collectionId) && (!eligible || eligible.includes(row.id)));
    let remaining = Math.abs(input.deltaDueCents);
    const applications = [];
    for (const row of candidates) {
      const amount = Math.min(remaining, input.deltaDueCents < 0 ? row.due : cents(row.amount_cents) - row.allocated - row.due);
      if (amount > 0) {
        const delta = input.deltaDueCents < 0 ? -amount : amount;
        applications.push({ collectionId: row.id, deltaDueCents: delta });
        row.due += delta;
        remaining -= amount;
      }
    }
    if (remaining) throw conflict();
    const row = { shopid: current.shopid, courier_id: courierId, collection_id: input.collectionId || null, remittance_id: input.remittanceId || null,
      delta_due_cents: input.deltaDueCents, reason: input.reason, actor_id: current.id, idempotency_key: input.idempotencyKey, request_hash: hash, created_at: now };
    // The public balance is rebuilt after the append; replay gets the saved
    // financial snapshot plus the exact SQL identity, never an order DTO.
    const projected = balanceView({ ...state, adjustments: [...state.adjustments, { ...row, id: null }] }, current.shopid, courierId);
    const adjustmentId = await repo.appendAdjustment({ connection, row: { ...row, result: JSON.stringify({ applications, response: { balance: projected } }) } });
    projected.adjustments[projected.adjustments.length - 1].adjustmentId = adjustmentId;
    return { adjustmentId, balance: projected };
  });
  return { balance, remit, adjust };
};

const buildCourierCashSummary = async ({ shopId, openedAt, closedAt, archivedOrders, connection }) => {
  const state = cashState(await repository.journal({ shopId, closedAt, connection }));
  const inPeriod = row => (!openedAt || row.created_at > openedAt) && row.created_at <= closedAt;
  const collections = state.collections.filter(inPeriod);
  const remittances = state.remittances.filter(inPeriod);
  const adjustments = state.adjustments.filter(inPeriod);
  const archivedIds = archivedOrders.filter(row => row.delivery_id).map(row => String(row.delivery_id));
  const sales = archivedIds.length ? await query(connection, `SELECT c.amount_cents FROM delivery_payment_collections c
    JOIN payments p ON p.id=c.payment_id AND p.shop_id=c.shopid
    JOIN deliveries d ON d.id=c.delivery_id AND d.shopid=c.shopid AND d.origin_order_id=p.order_id
    WHERE c.shopid=? AND c.method='cash' AND c.delivery_id IN (?)`, [shopId, archivedIds]) : [];
  const courierSales = sum(sales.map(row => row.amount_cents));
  const { normalizePaymentMethod } = require("../helpers/paymentMethod");
  const cashSales = sum(archivedOrders.filter(row => normalizePaymentMethod(row.payment, row.payment_provider) === normalizePaymentMethod("cash"))
    .map(row => require("../helpers/deliveryMoney").toCents(row.subtotal)));
  return {
    collected_cents: sum(collections.map(row => row.amount_cents)), received_cents: sum(remittances.map(row => row.received_cents)),
    outstanding_cents: sum(state.collections.map(row => row.due)), discrepancy_cents: sum(remittances.map(row => row.discrepancy_cents)),
    adjusted_due_cents: sum(adjustments.map(row => row.delta_due_cents)), surplus_cents: sum(remittances.map(row => Math.max(0, cents(row.discrepancy_cents)))),
    courier_cash_sales_cents: courierSales, register_cash_sales_cents: cents(cashSales - courierSales),
    remittances_count: remittances.length, adjustments_count: adjustments.length,
    first_event_at: [...collections, ...remittances, ...adjustments].map(row => row.created_at).sort()[0] || null,
  };
};
module.exports = { buildCourierCash, buildCourierCashSummary, cashPostingTime: explicitTime };
