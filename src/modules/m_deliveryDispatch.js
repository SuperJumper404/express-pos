const crypto = require("crypto");
const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { withTransaction } = require("../helpers/withTransaction");
const { resolveDeliveryOrder, toDeliveryView } = require("./m_deliveryOrders");
const { assertDeliveryActor, assertDeliveryOwner, isCourier, isDeliveryOperator, forbidden } = require("../helpers/deliveryAuthorization");

const json = value => typeof value === "string" ? JSON.parse(value) : value;
const query = async (connection, sql, values = []) => (await (connection || pool).query(sql, values))[0];
const invalid = () => new DomainError(400, "DELIVERY_REQUEST_INVALID", "Invalid delivery request");
const conflict = (code = "DELIVERY_TRANSITION_INVALID", view) => new DomainError(409, code, "Delivery action conflicts with current state", view ? { delivery: view } : {});
const closed = delivery => ["delivered", "failed", "canceled"].includes(delivery.delivery_status);
const date = value => new Date(value).toISOString().slice(0, 19).replace("T", " ");
const snapshot = delivery => ({ deliveryStatus: delivery.delivery_status, courierId: delivery.courier_id, closedAt: delivery.closed_at });

const repository = {
  resolve: resolveDeliveryOrder,
  findAccount: async ({ id, shopId, connection }) => (await query(connection,
    "SELECT id, shopid, username, access, status, module_permissions, courier_available FROM users WHERE shopid = ? AND id = ? FOR UPDATE", [shopId, id]))[0],
  findEvent: async ({ shopId, idempotencyKey, connection }) => (await query(connection,
    "SELECT CAST(id AS CHAR) AS id, CAST(delivery_id AS CHAR) AS delivery_id, request_hash FROM delivery_events WHERE shopid = ? AND idempotency_key = ? FOR UPDATE", [shopId, idempotencyKey]))[0],
  findIssue: async ({ shopId, deliveryId, connection }) => (await query(connection,
    "SELECT previous_state FROM delivery_events WHERE shopid = ? AND delivery_id = ? AND event_type = 'reportIssue' ORDER BY version DESC LIMIT 1 FOR UPDATE", [shopId, deliveryId]))[0],
  save: ({ delivery, connection, now }) => query(connection,
    "UPDATE deliveries SET courier_id = ?, delivery_status = ?, version = ?, closed_at = ?, updated_at = ? WHERE shopid = ? AND id = ?",
    [delivery.courier_id, delivery.delivery_status, delivery.version, delivery.closed_at || null, now, delivery.shopid, delivery.id]),
  appendEvent: async ({ event, connection }) => {
    await query(connection, "INSERT INTO delivery_events SET ?", [event]);
    // insertId is not exact on the production mysql2 pool for BIGINT values.
    return (await query(connection, "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id"))[0].id;
  },
  listIds: ({ actor, connection }) => query(connection,
    `SELECT CAST(id AS CHAR) AS id FROM deliveries WHERE shopid = ?${isCourier(actor) ? " AND courier_id = ?" : ""} ORDER BY created_at DESC, id DESC LIMIT 100`,
    isCourier(actor) ? [actor.shopId, actor.id] : [actor.shopId]),
  items: async ({ order, orderKind, connection }) => {
    const archived = orderKind === "archive";
    const table = archived ? "archivesdetail" : "orderdetail";
    const foreign = archived ? "archivesdetail_id" : "orderdetail_id";
    const snapshots = archived ? "archivesdetail_customization_snapshots" : "orderdetail_customization_snapshots";
    // Archive can commit after the resolver's identity pre-read opened an RR snapshot.
    const rows = await query(connection, `SELECT id, productid AS productId, qty AS quantity, price AS unitPrice
      FROM ${table} WHERE orderid = ? ORDER BY id FOR UPDATE`, [order.id]);
    if (!rows.length) return [];
    const products = await query(connection, "SELECT id, name FROM products WHERE shopid = ? AND id IN (?)", [order.shopid, rows.map(row => row.productId)]);
    const names = new Map(products.map(product => [product.id, product.name]));
    const choices = await query(connection, `SELECT ${foreign} AS detailId, step_name, choice_name, unit_extra_price
      FROM ${snapshots} WHERE ${foreign} IN (?) ORDER BY step_position, choice_position, id FOR UPDATE`, [rows.map(row => row.id)]);
    return rows.map(row => ({ name: names.get(row.productId) || null, quantity: row.quantity, unitPrice: row.unitPrice,
      customizations: choices.filter(choice => choice.detailId === row.id).map(choice => ({ step: choice.step_name, choice: choice.choice_name, unitExtraPrice: choice.unit_extra_price })) }));
  },
  listCouriers: ({ shopId, connection }) => query(connection,
    `SELECT u.id, u.username, u.status, u.courier_available AS available,
      (SELECT COUNT(*) FROM deliveries d WHERE d.shopid = u.shopid AND d.courier_id = u.id AND d.delivery_status IN ('assigned','in_transit','issue')) AS missionCount
      FROM users u WHERE u.shopid = ? AND u.access = 6 ORDER BY u.id`, [shopId]),
  setAvailability: ({ id, shopId, available, connection }) => query(connection,
    "UPDATE users SET courier_available = ? WHERE shopid = ? AND id = ?", [available ? 1 : 0, shopId, id]),
};

const buildDeliveryDispatch = ({ repository: repo = repository, runInTransaction = withTransaction, clock = () => new Date() } = {}) => {
  const reload = async (actor, connection) => {
    if (!actor || actor.subject !== "staff" || !actor.id || !actor.shopId) throw forbidden();
    const account = await repo.findAccount({ id: actor.id, shopId: actor.shopId, connection });
    if (!account || Number(account.status) !== 1) throw forbidden();
    const current = { subject: "staff", id: account.id, shopId: account.shopid, access: Number(account.access), module_permissions: account.module_permissions };
    assertDeliveryActor(current);
    return current;
  };
  const resolve = async (actor, deliveryId, connection) => {
    if (!actor || actor.subject !== "staff" || !actor.shopId || !actor.id) throw forbidden();
    const current = await repo.resolve({ shopId: actor.shopId, deliveryId, connection, forUpdate: true });
    if (!current) throw new DomainError(404, "DELIVERY_NOT_FOUND", "Delivery not found");
    const effectiveActor = await reload(actor, connection);
    assertDeliveryOwner(effectiveActor, current.delivery);
    return { ...current, actor: effectiveActor };
  };
  const project = async (current, connection) => {
    if (!closed(current.delivery)) current.order.items = await repo.items({ ...current, connection });
    return toDeliveryView(current);
  };
  const target = async (actor, courierId, connection) => {
    if (!Number.isSafeInteger(courierId) || courierId <= 0) throw invalid();
    const account = await repo.findAccount({ id: courierId, shopId: actor.shopId, connection });
    if (!account || Number(account.access) !== 6 || Number(account.status) !== 1 || Number(account.courier_available) !== 1) throw conflict("DELIVERY_COURIER_UNAVAILABLE");
    return account.id;
  };
  const mutate = name => async input => {
    const { expectedVersion, idempotencyKey, deliveryId } = input;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 191) throw invalid();
    const reason = input.reason === undefined ? null : input.reason;
    if (reason !== null && (typeof reason !== "string" || !reason.trim() || reason.length > 2000)) throw invalid();
    const payload = { name, deliveryId: String(deliveryId), expectedVersion, actorId: String(input.actor && input.actor.id),
      courierId: input.courierId === undefined ? null : input.courierId, action: input.action || null, reason,
      physicalTransferConfirmed: input.physicalTransferConfirmed === true };
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    try { return await runInTransaction(async connection => {
      const current = await resolve(input.actor, deliveryId, connection);
      const { actor, delivery, order } = current;
      const operator = isDeliveryOperator(actor);
      if (["assign", "resolveIssue"].includes(name) && !operator) throw forbidden();
      if (["pickup", "deliver"].includes(name) && !isCourier(actor)) throw forbidden();
      const event = await repo.findEvent({ shopId: actor.shopId, idempotencyKey, connection });
      if (event) {
        if (event.request_hash !== requestHash || String(event.delivery_id) !== String(deliveryId)) throw conflict("DELIVERY_IDEMPOTENCY_CONFLICT");
        return { ...await project(current, connection), eventId: String(event.id), idempotentReplay: true };
      }
      if (delivery.version !== expectedVersion) throw conflict("DELIVERY_VERSION_CONFLICT", await project(current, connection));
      const view = toDeliveryView(current);
      if (closed(delivery) || view.acceptanceStatus !== "accepted") throw conflict();
      const previous = snapshot(delivery);
      if (name === "assign") {
        if (!["unassigned", "assigned"].includes(delivery.delivery_status)) throw conflict();
        delivery.courier_id = await target(actor, input.courierId, connection);
        delivery.delivery_status = "assigned";
      } else if (name === "pickup") {
        if (delivery.delivery_status !== "assigned") throw conflict();
        if (Number(view.preparationStatus) !== 3) throw conflict("DELIVERY_PREPARATION_NOT_FINISHED");
        delivery.delivery_status = "in_transit";
      } else if (name === "reportIssue") {
        if (!reason) throw invalid();
        if (!["assigned", "in_transit"].includes(delivery.delivery_status)) throw conflict();
        delivery.delivery_status = "issue";
      } else if (name === "deliver") {
        if (delivery.delivery_status !== "in_transit") throw conflict();
        if (view.remainingDueCents !== 0) throw conflict("DELIVERY_PAYMENT_NOT_SETTLED");
        delivery.delivery_status = "delivered";
      } else if (name === "resolveIssue") {
        if (!reason || !["resume", "retry", "return", "fail", "cancel", "confirm_unpaid_delivery"].includes(input.action)) throw invalid();
        if (delivery.delivery_status !== "issue") throw conflict();
        const issue = await repo.findIssue({ shopId: actor.shopId, deliveryId, connection });
        const prior = issue && json(issue.previous_state).deliveryStatus;
        if (!["assigned", "in_transit"].includes(prior)) throw conflict();
        const physicalTransfer = ["retry", "return"].includes(input.action) || input.courierId !== undefined;
        if (prior === "in_transit" && physicalTransfer && input.physicalTransferConfirmed !== true) throw conflict("DELIVERY_PHYSICAL_CONFIRMATION_REQUIRED");
        if (input.action === "resume") {
          if (input.courierId !== undefined) throw invalid();
          delivery.delivery_status = prior;
        } else if (input.action === "retry") {
          delivery.courier_id = await target(actor, input.courierId === undefined ? delivery.courier_id : input.courierId, connection);
          delivery.delivery_status = "assigned";
        } else if (input.action === "return") {
          delivery.courier_id = null;
          delivery.delivery_status = "unassigned";
        } else if (input.action === "confirm_unpaid_delivery") {
          if (prior !== "in_transit" || view.remainingDueCents === 0) throw conflict();
          delivery.delivery_status = "delivered";
        } else delivery.delivery_status = input.action === "fail" ? "failed" : "canceled";
      }
      delivery.version += 1;
      const now = date(clock());
      if (closed(delivery)) delivery.closed_at = now;
      await repo.save({ delivery, now, connection });
      const next = snapshot(delivery);
      const eventId = await repo.appendEvent({ connection, event: {
        shopid: actor.shopId, delivery_id: String(delivery.id), version: delivery.version,
        event_type: name, actor_subject: actor.subject, actor_id: String(actor.id),
        previous_state: JSON.stringify(previous), next_state: JSON.stringify(next), reason,
        idempotency_key: idempotencyKey, request_hash: requestHash,
        result: JSON.stringify({ ...next, version: delivery.version, action: input.action || null, physicalTransferConfirmed: input.physicalTransferConfirmed === true }), created_at: now,
      } });
      return { ...await project({ ...current, order }, connection), eventId: String(eventId), idempotentReplay: false };
    }); } catch (error) {
      if (error.code === "ER_DUP_ENTRY") throw conflict("DELIVERY_IDEMPOTENCY_CONFLICT");
      throw error;
    }
  };
  return {
    assign: mutate("assign"), pickup: mutate("pickup"), reportIssue: mutate("reportIssue"), resolveIssue: mutate("resolveIssue"), deliver: mutate("deliver"),
    get: ({ actor, deliveryId }) => runInTransaction(async connection => project(await resolve(actor, deliveryId, connection), connection)),
    list: async ({ actor }) => {
      const currentActor = await runInTransaction(connection => reload(actor, connection));
      const ids = await repo.listIds({ actor: currentActor });
      const views = [];
      for (const row of ids) {
        try { views.push(await runInTransaction(async connection => project(await resolve(actor, row.id, connection), connection))); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      return views;
    },
    couriers: ({ actor }) => runInTransaction(async connection => {
      const current = await reload(actor, connection);
      if (!isDeliveryOperator(current)) throw forbidden();
      return repo.listCouriers({ shopId: current.shopId, connection });
    }),
    availability: ({ actor, courierId, available }) => runInTransaction(async connection => {
      if (typeof available !== "boolean") throw invalid();
      const current = await reload(actor, connection);
      const id = isCourier(current) ? current.id : courierId;
      if (isCourier(current) && courierId !== undefined && String(courierId) !== String(current.id)) throw forbidden();
      const account = await repo.findAccount({ id, shopId: current.shopId, connection });
      if (!account || Number(account.access) !== 6 || Number(account.status) !== 1) throw forbidden();
      await repo.setAvailability({ id, shopId: current.shopId, available, connection });
      return { courierId: id, available };
    }),
  };
};
module.exports = { buildDeliveryDispatch };
