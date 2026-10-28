const crypto = require('crypto');
const DomainError = require('../helpers/domainError');
const { normalizeProgram, earnedPoints, rewardDiscount, refundRestitution, allocateDiscount, integer, invalid } = require('../helpers/loyalty');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const sqlTime = date => new Date(date).toISOString().slice(0, 19).replace('T', ' ');
const missing = () => new DomainError(404, 'LOYALTY_NOT_FOUND', 'Loyalty membership not found');
const conflict = (code, message) => new DomainError(409, code, message);
const scopeValid = ({ shopId }) => integer(shopId, 1, 2147483647);
const orderValid = value => integer(Number(value), 1, 2147483647);
const eventValid = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,150}$/.test(value)) throw invalid();
  return value;
};

const buildSqlLoyaltyRepository = ({ pool = require('../config/dbPool') } = {}) => ({
  async lockShop({ shopId, connection }) {
    const [[row]] = await connection.query('SELECT id FROM shop WHERE id=? FOR UPDATE', [shopId]);
    if (!row) throw missing();
  },
  async program({ shopId, connection }) {
    const [[row]] = await connection.query('SELECT config,version FROM loyalty_programs WHERE shopid=?', [shopId]); return row;
  },
  async saveProgram({ shopId, program, connection }) {
    await connection.query(`INSERT INTO loyalty_programs (shopid,config) VALUES (?,?) ON DUPLICATE KEY UPDATE
      config=VALUES(config),version=version+1,updated_at=UTC_TIMESTAMP()`, [shopId, JSON.stringify(program)]);
    const [members] = await connection.query('SELECT id,revision FROM loyalty_members WHERE shopid=? FOR UPDATE', [shopId]);
    for (const member of members) {
      await connection.query('UPDATE loyalty_members SET revision=revision+1 WHERE shopid=? AND id=?', [shopId, member.id]);
      await this.enqueue({ shopId, memberId: member.id, revision: Number(member.revision) + 1, connection });
    }
  },
  async customer({ shopId, customerId, connection }) {
    const [[row]] = await connection.query('SELECT CAST(id AS CHAR) AS id FROM customers WHERE shopid=? AND id=? FOR UPDATE', [shopId, customerId]); return row;
  },
  async member({ shopId, memberId, customerId, qr, connection }) {
    const column = memberId ? 'id' : customerId ? 'customer_id' : 'qr';
    const [[row]] = await connection.query(`SELECT *, CAST(customer_id AS CHAR) AS customer_id FROM loyalty_members WHERE shopid=? AND ${column}=? FOR UPDATE`, [shopId, memberId || customerId || qr]);
    return row && { ...row, balance: Number(row.balance), reserved: Number(row.reserved), revision: Number(row.revision) };
  },
  insertMember: ({ id, shopid, customer_id, qr, connection }) => connection.query('INSERT INTO loyalty_members (id,shopid,customer_id,qr,created_at,updated_at) VALUES (?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())', [id, shopid, customer_id, qr]),
  saveMember: ({ id, shopid, balance, reserved, revision, connection }) => connection.query(
    'UPDATE loyalty_members SET balance=?,reserved=?,revision=?,updated_at=UTC_TIMESTAMP() WHERE shopid=? AND id=?', [balance, reserved, revision, shopid, id]),
  async history({ shopId, memberId, connection }) {
    const [rows] = await connection.query(`SELECT CAST(id AS CHAR) AS id,kind,points,reason,order_id AS orderId,
      DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%sZ') AS createdAt FROM loyalty_ledger WHERE shopid=? AND member_id=? ORDER BY id DESC LIMIT 100`, [shopId, memberId]);
    return rows.map(row => ({ ...row, points: Number(row.points) }));
  },
  async members({ shopId, connection }) {
    const [rows] = await connection.query(`SELECT m.id,CAST(m.customer_id AS CHAR) AS customerId,c.name,m.balance,m.reserved
      FROM loyalty_members m JOIN customers c ON c.shopid=m.shopid AND c.id=m.customer_id WHERE m.shopid=? ORDER BY m.created_at DESC LIMIT 250`, [shopId]);
    return rows.map(row => ({ ...row, balance: Number(row.balance), reserved: Number(row.reserved), available: Number(row.balance) - Number(row.reserved) }));
  },
  async order({ shopId, orderId, connection }) {
    const [[row]] = await connection.query(`SELECT *,DATE_FORMAT(reservation_expires_at,'%Y-%m-%dT%H:%i:%sZ') AS reservation_expires_at
      FROM loyalty_orders WHERE shopid=? AND order_id=? FOR UPDATE`, [shopId, orderId]);
    if (!row) return null;
    for (const key of ['points_cost', 'discount_cents', 'paid_cents', 'refunded_cents', 'restored_points']) row[key] = Number(row[key]);
    row.rule_snapshot = parse(row.rule_snapshot); row.reward_snapshot = parse(row.reward_snapshot);
    return row;
  },
  insertOrder: ({ shopid, order_id, member_id, rule_snapshot, connection }) => connection.query(
    'INSERT INTO loyalty_orders (shopid,order_id,member_id,rule_snapshot) VALUES (?,?,?,?)', [shopid, order_id, member_id, JSON.stringify(rule_snapshot)]),
  saveOrder: ({ shopid, order_id, rule_snapshot, reward_snapshot, points_cost, discount_cents, paid_cents, refunded_cents, restored_points, status, reservation_expires_at, connection }) => connection.query(
    `UPDATE loyalty_orders SET rule_snapshot=?,reward_snapshot=?,points_cost=?,discount_cents=?,paid_cents=?,refunded_cents=?,restored_points=?,status=?,reservation_expires_at=? WHERE shopid=? AND order_id=?`,
    [JSON.stringify(rule_snapshot), reward_snapshot ? JSON.stringify(reward_snapshot) : null, points_cost, discount_cents, paid_cents, refunded_cents, restored_points, status,
      reservation_expires_at ? sqlTime(reservation_expires_at) : null, shopid, order_id]),
  async sourceOrder({ shopId, orderId, connection }) {
    const [[row]] = await connection.query('SELECT *,CAST(customer_account_id AS CHAR) AS customer_account_id FROM orders WHERE shopid=? AND id=? FOR UPDATE', [shopId, orderId]); return row;
  },
  async lines({ shopId, orderId, connection }) {
    const [rows] = await connection.query(`SELECT d.productid AS productId,d.qty AS quantity,d.price,d.total FROM orderdetail d
      JOIN orders o ON o.id=d.orderid WHERE o.shopid=? AND o.id=? ORDER BY d.id`, [shopId, orderId]);
    return rows.map(row => ({ productId: Number(row.productId), quantity: Number(row.quantity),
      unitCents: Math.round(Number(row.price) * 100), totalCents: Math.round(Number(row.total) * 100) }));
  },
  async checkoutLines({ shopId, orderId, connection }) {
    const [rows] = await connection.query(`SELECT d.* FROM orderdetail d JOIN orders o ON o.id=d.orderid
      WHERE o.shopid=? AND o.id=? ORDER BY d.id FOR UPDATE`, [shopId, orderId]); return rows;
  },
  async applyCheckoutPrice({ shopId, orderId, subtotalCents, subtotalBeforeDiscount, discountAmount, discountType, discountValue, lines, connection }) {
    await connection.query(`UPDATE orders SET subtotal=?,subtotal_before_discount=?,discount_amount=?,discount_type=?,discount_value=? WHERE shopid=? AND id=?`,
      [subtotalCents / 100, subtotalBeforeDiscount, discountAmount, discountType, discountValue, shopId, orderId]);
    for (const line of lines) await connection.query(`UPDATE orderdetail SET total=?,unit_price_ht=?,unit_vat=?,total_ht=?,total_vat=? WHERE orderid=? AND id=?`,
      [line.total, line.unit_price_ht, line.unit_vat, line.total_ht, line.total_vat, orderId, line.id]);
  },
  async event({ shopId, eventKey, connection }) {
    const [[row]] = await connection.query('SELECT id FROM loyalty_ledger WHERE shopid=? AND event_key=?', [shopId, eventKey]); return row;
  },
  ledger: ({ shopId, memberId, orderId = null, eventKey, kind, points, reason = '', actorId = null, connection }) => connection.query(
    'INSERT INTO loyalty_ledger (shopid,member_id,order_id,event_key,kind,points,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP())', [shopId, memberId, orderId, eventKey, kind, points, reason, actorId]),
  enqueue: ({ shopId, memberId, revision, connection }) => connection.query(
    'INSERT IGNORE INTO loyalty_wallet_jobs (shopid,member_id,revision,next_attempt_at,created_at) VALUES (?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())', [shopId, memberId, revision]),
  async expired({ connection, now }) {
    const [rows] = await connection.query(`SELECT shopid,order_id FROM loyalty_orders l WHERE l.status='reserved' AND l.reservation_expires_at < ?
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.shopid=l.shopid AND o.id=l.order_id AND o.payment_status='requires_payment')
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.shop_id=l.shopid AND p.order_id=l.order_id AND p.status IN ('pending','processing'))
      AND NOT EXISTS (SELECT 1 FROM stripe_terminal_payment_orders a JOIN stripe_terminal_payments p ON p.id=a.terminal_payment_id
        WHERE a.shopid=l.shopid AND a.order_id=l.order_id AND p.status IN ('creating','processing')) LIMIT 100`, [sqlTime(now)]); return rows;
  },
  async paymentBusy({ shopId, orderId, connection }) {
    const [[row]] = await connection.query(`SELECT EXISTS(SELECT 1 FROM orders WHERE shopid=? AND id=? AND payment_status='requires_payment')
      OR EXISTS(SELECT 1 FROM stripe_terminal_payment_orders a JOIN stripe_terminal_payments p ON p.id=a.terminal_payment_id AND p.shopid=a.shopid
        WHERE a.shopid=? AND a.order_id=? AND p.status IN ('creating','processing')) AS busy`, [shopId, orderId, shopId, orderId]);
    return !!Number(row.busy);
  },
});

const buildLoyalty = ({ repository = buildSqlLoyaltyRepository(), runInTransaction = require('../helpers/withTransaction').withTransaction,
  clock = () => new Date() } = {}) => {
  const transaction = (scope, work) => {
    scopeValid(scope);
    return runInTransaction(async connection => {
      await repository.lockShop({ ...scope, connection }); return work(connection);
    });
  };
  const programFor = async scope => {
    const row = await repository.program(scope);
    return { ...normalizeProgram(row ? parse(row.config) : {}), version: row ? row.version : 0 };
  };
  const memberFor = async scope => {
    const row = await repository.member(scope); if (!row) throw missing(); return row;
  };
  const change = async (member, connection) => {
    integer(member.balance); integer(member.reserved);
    if (member.reserved > member.balance) throw conflict('LOYALTY_INSUFFICIENT_POINTS', 'Insufficient available points');
    member.revision++;
    await repository.saveMember({ ...member, connection });
    await repository.enqueue({ shopId: member.shopid, memberId: member.id, revision: member.revision, connection });
  };
  const view = async (member, connection) => {
    const program = await programFor({ shopId: member.shopid, connection });
    return { id: member.id, qr: member.qr, balance: member.balance, reserved: member.reserved, available: member.balance - member.reserved,
      program, rewards: program.rewards.map(reward => ({ ...reward, available: program.enabled && reward.points <= member.balance - member.reserved
        && (!reward.expiresAt || Date.parse(reward.expiresAt) > clock().getTime()) })),
      history: await repository.history({ shopId: member.shopid, memberId: member.id, connection }) };
  };
  const orderFor = async scope => {
    orderValid(scope.orderId);
    const row = await repository.order(scope); if (!row) throw missing(); return row;
  };
  const attachTo = async ({ shopId, orderId, member, connection }) => {
    orderId = orderValid(orderId);
    const existing = await repository.order({ shopId, orderId, connection });
    if (existing && existing.member_id !== member.id) throw conflict('LOYALTY_ORDER_ASSIGNED', 'Order already belongs to another membership');
    if (existing) return { orderId, memberId: existing.member_id, status: existing.status, reward: existing.reward_snapshot,
      pointsCost: existing.points_cost, discountCents: existing.discount_cents, expiresAt: existing.reservation_expires_at };
    const program = await programFor({ shopId, connection });
    if (!program.enabled) throw conflict('LOYALTY_DISABLED', 'Loyalty program disabled');
    const lines = await repository.lines({ shopId, orderId, connection });
    await repository.insertOrder({ shopid: shopId, order_id: orderId, member_id: member.id,
      rule_snapshot: { ...program, lines }, connection });
    return { orderId, memberId: member.id, status: 'attached' };
  };
  const releaseIn = async ({ shopId, orderId, connection, kind = 'release' }) => {
    scopeValid({ shopId }); orderId = orderValid(orderId);
    const order = await repository.order({ shopId, orderId, connection });
    if (!order || order.status !== 'reserved') return { released: false };
    const member = await memberFor({ shopId, memberId: order.member_id, connection });
    if (order.rule_snapshot.discountApplied && order.rule_snapshot.checkoutOriginal) {
      const original = order.rule_snapshot.checkoutOriginal;
      await repository.applyCheckoutPrice({ shopId, orderId, ...original, connection });
      delete order.rule_snapshot.discountApplied; delete order.rule_snapshot.checkoutOriginal;
    }
    member.reserved -= order.points_cost;
    await repository.ledger({ shopId, memberId: member.id, orderId, eventKey: `release:${crypto.randomUUID()}`, kind,
      points: 0, reason: 'Reservation released', connection });
    Object.assign(order, { status: 'released', points_cost: 0, discount_cents: 0, reward_snapshot: null, reservation_expires_at: null });
    await repository.saveOrder({ ...order, connection }); await change(member, connection);
    return { released: true };
  };
  const service = {
    getProgram: scope => transaction(scope, connection => programFor({ ...scope, connection })),
    saveProgram: ({ shopId, program }) => transaction({ shopId }, async connection => {
      const normalized = normalizeProgram(program);
      await repository.saveProgram({ shopId, program: normalized, connection }); return programFor({ shopId, connection });
    }),
    enroll: ({ shopId, customerId }) => transaction({ shopId }, async connection => {
      if (!await repository.customer({ shopId, customerId, connection })) throw missing();
      const program = await programFor({ shopId, connection });
      if (!program.enabled) throw conflict('LOYALTY_DISABLED', 'Loyalty program disabled');
      let member = await repository.member({ shopId, customerId, connection });
      if (!member) {
        member = { id: crypto.randomUUID(), shopid: shopId, customer_id: customerId, qr: crypto.randomBytes(32).toString('hex'), balance: 0, reserved: 0, revision: 1 };
        await repository.insertMember({ ...member, connection });
        await repository.enqueue({ shopId, memberId: member.id, revision: member.revision, connection });
      }
      return view(member, connection);
    }),
    getMember: scope => transaction(scope, async connection => {
      const member = await repository.member({ ...scope, connection });
      return member ? view(member, connection) : scope.customerId ? { member: null, program: await programFor({ ...scope, connection }) } : Promise.reject(missing());
    }),
    listMembers: scope => transaction(scope, connection => repository.members({ ...scope, connection })),
    lookup: ({ shopId, qr }) => transaction({ shopId }, async connection => {
      if (typeof qr !== 'string' || !/^[a-f0-9]{64}$/.test(qr)) throw missing();
      return view(await memberFor({ shopId, qr, connection }), connection);
    }),
    adjust: ({ shopId, memberId, points, reason, actorId }) => transaction({ shopId }, async connection => {
      integer(points, -1000000000); if (!points || typeof reason !== 'string' || !reason.trim() || reason.length > 1000 || /[\x00-\x1f\x7f]/.test(reason)) throw invalid();
      const member = await memberFor({ shopId, memberId, connection }); member.balance += points;
      await change(member, connection);
      await repository.ledger({ shopId, memberId, eventKey: `adjust:${crypto.randomUUID()}`, kind: 'adjustment', points, reason: reason.trim(), actorId, connection });
      return view(member, connection);
    }),
    attach: ({ shopId, orderId, qr }) => transaction({ shopId }, async connection => {
      const source = await repository.sourceOrder({ shopId, orderId: orderValid(orderId), connection });
      if (!source) throw missing();
      if (['paid', 'refunded'].includes(source.payment_status) || await repository.paymentBusy({ shopId, orderId, connection })) {
        throw conflict('LOYALTY_PAYMENT_ACTIVE', 'Payment already started or completed');
      }
      if (typeof qr !== 'string' || !/^[a-f0-9]{64}$/.test(qr)) throw missing();
      return attachTo({ shopId, orderId, member: await memberFor({ shopId, qr, connection }), connection });
    }),
    async attachCustomerOrder({ connection, shopId, orderId, customerId }) {
      scopeValid({ shopId });
      const source = await repository.sourceOrder({ shopId, orderId: orderValid(orderId), connection });
      if (!source || String(source.customer_account_id) !== String(customerId)) throw missing();
      const member = await repository.member({ shopId, customerId, connection });
      if (!member || !(await programFor({ shopId, connection })).enabled) return null;
      return attachTo({ shopId, orderId, member, connection });
    },
    reserve: ({ shopId, orderId, rewardId, confirmed, connection: existingConnection }) => {
      const reserveIn = async connection => {
      if (confirmed !== true) throw new DomainError(422, 'LOYALTY_CONFIRMATION_REQUIRED', 'Explicit confirmation required');
      const source = await repository.sourceOrder({ shopId, orderId: orderValid(orderId), connection }); if (!source) throw missing();
      if (!existingConnection && (['paid', 'refunded'].includes(source.payment_status) || await repository.paymentBusy({ shopId, orderId, connection }))) {
        throw conflict('LOYALTY_PAYMENT_ACTIVE', 'Payment already started or completed');
      }
      const order = await orderFor({ shopId, orderId, connection });
      if (order.status === 'paid') throw conflict('LOYALTY_ORDER_PAID', 'Order already paid');
      if (order.status === 'reserved') throw conflict('LOYALTY_ALREADY_RESERVED', 'Points already reserved');
      const program = await programFor({ shopId, connection });
      const reward = program.rewards.find(row => row.id === rewardId);
      if (!program.enabled || !reward || (reward.expiresAt && Date.parse(reward.expiresAt) <= clock().getTime())) throw conflict('LOYALTY_REWARD_UNAVAILABLE', 'Reward unavailable');
      if (!reward.stackable && Number(source.discount_amount) > 0) throw conflict('LOYALTY_NOT_STACKABLE', 'Reward cannot be combined with another discount');
      const member = await memberFor({ shopId, memberId: order.member_id, connection });
      if (member.balance - member.reserved < reward.points) throw conflict('LOYALTY_INSUFFICIENT_POINTS', 'Insufficient available points');
      const subtotalCents = Math.round(Number(source.subtotal) * 100);
      integer(subtotalCents);
      if (subtotalCents < reward.minPaidCents) throw conflict('LOYALTY_REWARD_CONDITIONS', 'Reward minimum amount not reached');
      const lines = await repository.lines({ shopId, orderId, connection });
      const discountCents = rewardDiscount({ reward, subtotalCents, lines });
      if (!discountCents) throw conflict('LOYALTY_REWARD_CONDITIONS', 'Reward product not present');
      const expiresAt = new Date(clock().getTime() + 15 * 60000).toISOString();
      Object.assign(order, { status: 'reserved', rule_snapshot: { ...program, lines }, reward_snapshot: reward, points_cost: reward.points,
        discount_cents: discountCents, reservation_expires_at: expiresAt });
      member.reserved += reward.points;
      await repository.saveOrder({ ...order, connection }); await change(member, connection);
      await repository.ledger({ shopId, memberId: member.id, orderId, eventKey: `reserve:${crypto.randomUUID()}`, kind: 'reserve', points: 0, reason: `${reward.points} points reserved`, connection });
      return { orderId: Number(orderId), discountCents, pointsCost: reward.points, expiresAt, reward };
      };
      return existingConnection ? reserveIn(existingConnection) : transaction({ shopId }, reserveIn);
    },
    async applyCheckoutReward({ connection, shopId, orderId, customerId, rewardId, confirmed }) {
      if (!connection) throw invalid(); scopeValid({ shopId }); orderId = orderValid(orderId);
      await service.attachCustomerOrder({ connection, shopId, orderId, customerId });
      const source = await repository.sourceOrder({ shopId, orderId, connection });
      const lines = await repository.checkoutLines({ shopId, orderId, connection });
      const result = await service.reserve({ connection, shopId, orderId, rewardId, confirmed });
      const subtotalCents = integer(Math.round(Number(source.subtotal) * 100));
      // Includes previous normal discounts but never delivery fees: delivery checkout must be rejected by its caller.
      const discountedLines = allocateDiscount(lines, result.discountCents);
      const totalCents = subtotalCents - result.discountCents;
      const original = { subtotalCents, subtotalBeforeDiscount: source.subtotal_before_discount == null ? source.subtotal : source.subtotal_before_discount,
        discountAmount: Number(source.discount_amount) || 0, discountType: source.discount_type || 'none', discountValue: Number(source.discount_value) || 0, lines };
      const combinedDiscount = (Math.round(original.discountAmount * 100) + result.discountCents) / 100;
      await repository.applyCheckoutPrice({ shopId, orderId, subtotalCents: totalCents, subtotalBeforeDiscount: original.subtotalBeforeDiscount,
        discountAmount: combinedDiscount, discountType: 'amount', discountValue: combinedDiscount, lines: discountedLines, connection });
      const order = await orderFor({ shopId, orderId, connection });
      order.rule_snapshot.discountApplied = true; order.rule_snapshot.checkoutOriginal = original;
      await repository.saveOrder({ ...order, connection });
      return { discountCents: result.discountCents, totalCents };
    },
    release: scope => scope.connection ? releaseIn(scope) : transaction(scope, async connection => {
      orderValid(scope.orderId);
      if (await repository.paymentBusy({ ...scope, connection })) throw conflict('LOYALTY_PAYMENT_ACTIVE', 'Payment is in progress');
      return releaseIn({ ...scope, connection });
    }),
    async getOrderDiscount({ connection, shopId, orderId, subtotalCents, otherDiscountCents = 0 }) {
      scopeValid({ shopId }); integer(subtotalCents); integer(otherDiscountCents);
      if (!connection) throw invalid();
      const order = await repository.order({ shopId, orderId: orderValid(orderId), connection });
      if (!order || order.status !== 'reserved') {
        if (order && order.discount_cents > 0 && order.status !== 'paid') throw conflict('LOYALTY_RESERVATION_EXPIRED', 'Loyalty reservation expired');
        return { discountCents: 0, pointsCost: 0, reward: null };
      }
      if (new Date(order.reservation_expires_at).getTime() <= clock().getTime()) throw conflict('LOYALTY_RESERVATION_EXPIRED', 'Loyalty reservation expired');
      if (order.rule_snapshot.discountApplied) {
        const source = await repository.sourceOrder({ shopId, orderId, connection });
        if (!source) throw missing();
        const currentPaid = Math.round(Number(source.subtotal) * 100);
        const originalPaid = order.rule_snapshot.checkoutOriginal.subtotalCents - order.discount_cents;
        if (currentPaid !== originalPaid) throw conflict('LOYALTY_REWARD_CONDITIONS', 'Order changed after loyalty reward was applied');
        // Both callers provide net requested as gross - otherDiscountCents. The gross may
        // include the already applied reward (archive) or be the saved net total (Terminal).
        if (subtotalCents - otherDiscountCents < currentPaid && !order.reward_snapshot.stackable) {
          throw conflict('LOYALTY_NOT_STACKABLE', 'Reward cannot be combined with another discount');
        }
        return { discountCents: 0, pointsCost: order.points_cost, reward: order.reward_snapshot };
      }
      if (otherDiscountCents > 0 && !order.reward_snapshot.stackable) throw conflict('LOYALTY_NOT_STACKABLE', 'Reward cannot be combined with another discount');
      // Reprice on current server lines to prevent cart edits after reservation changing the benefit.
      const lines = await repository.lines({ shopId, orderId, connection });
      const discountCents = rewardDiscount({ reward: order.reward_snapshot, subtotalCents: Math.max(0, subtotalCents - otherDiscountCents), lines });
      if (!discountCents || subtotalCents - otherDiscountCents < order.reward_snapshot.minPaidCents) throw conflict('LOYALTY_REWARD_CONDITIONS', 'Reward conditions no longer satisfied');
      order.discount_cents = discountCents; order.rule_snapshot.lines = lines;
      await repository.saveOrder({ ...order, connection });
      return { discountCents, pointsCost: order.points_cost, reward: order.reward_snapshot };
    },
    async settlePaidOrder({ connection, shopId, orderId, paymentKey, paidCents, tipCents = 0 }) {
      if (!connection) throw invalid(); scopeValid({ shopId }); orderId = orderValid(orderId); integer(paidCents); eventValid(paymentKey);
      let order = await repository.order({ shopId, orderId, connection });
      if (!order) {
        const source = await repository.sourceOrder({ shopId, orderId, connection });
        if (source && source.customer_account_id) await service.attachCustomerOrder({ connection, shopId, orderId, customerId: String(source.customer_account_id) });
        order = await repository.order({ shopId, orderId, connection });
      }
      if (!order || order.status === 'paid') return { credited: false };
      const eventKey = `earn:${paymentKey}:${orderId}`;
      if (await repository.event({ shopId, eventKey, connection })) return { credited: false };
      const member = await memberFor({ shopId, memberId: order.member_id, connection });
      const program = order.rule_snapshot;
      if (order.status !== 'reserved') {
        const currentLines = await repository.lines({ shopId, orderId, connection });
        // Programs remain snapshotted; cart contents may legitimately have changed
        // after association when no reward was reserved. Archived orders have no rows.
        if (currentLines.length) program.lines = currentLines;
      }
      const excludedGross = (program.lines || []).filter(line => program.excludedProductIds.includes(Number(line.productId))).reduce((sum, line) => sum + line.totalCents, 0);
      const gross = (program.lines || []).reduce((sum, line) => sum + line.totalCents, 0);
      const excludedCents = gross ? Math.min(paidCents, Math.floor(paidCents * excludedGross / gross)) : 0;
      const points = earnedPoints({ program, paidCents, tipCents, excludedCents });
      if (order.status === 'reserved') {
        member.reserved -= order.points_cost; member.balance -= order.points_cost;
        await repository.ledger({ shopId, memberId: member.id, orderId, eventKey: `spend:${paymentKey}:${orderId}`, kind: 'spend', points: -order.points_cost, connection });
      }
      member.balance += points;
      Object.assign(order, { status: 'paid', paid_cents: paidCents, reservation_expires_at: null });
      await repository.saveOrder({ ...order, connection }); await change(member, connection);
      await repository.ledger({ shopId, memberId: member.id, orderId, eventKey, kind: 'earn', points, connection });
      return { credited: true, points };
    },
    async refundOrder({ connection, shopId, orderId, refundedCents = 0, cumulativeRefundedCents, refundKey }) {
      if (!connection) throw invalid(); scopeValid({ shopId }); orderId = orderValid(orderId); integer(refundedCents); eventValid(refundKey);
      const order = await repository.order({ shopId, orderId, connection });
      if (!order) return { restored: false };
      const eventKey = `refund:${refundKey}:${orderId}`;
      if (await repository.event({ shopId, eventKey, connection })) return { restored: false };
      if (order.status !== 'paid') throw conflict('LOYALTY_ORDER_UNPAID', 'Order is not paid');
      let targetRefunded = order.refunded_cents + refundedCents;
      if (cumulativeRefundedCents !== undefined) {
        integer(cumulativeRefundedCents);
        if (cumulativeRefundedCents > order.paid_cents) throw invalid();
        if (cumulativeRefundedCents <= order.refunded_cents) return { restored: false };
        targetRefunded = cumulativeRefundedCents;
      }
      if (targetRefunded > order.paid_cents) throw invalid();
      const member = await memberFor({ shopId, memberId: order.member_id, connection });
      order.refunded_cents = targetRefunded;
      const restored = refundRestitution({ pointsCost: order.points_cost, paidCents: order.paid_cents, refundedCents: order.refunded_cents, restoredPoints: order.restored_points });
      order.restored_points += restored; member.balance += restored;
      await repository.saveOrder({ ...order, connection }); await change(member, connection);
      await repository.ledger({ shopId, memberId: member.id, orderId, eventKey, kind: 'refund', points: restored, reason: 'Spent points restored; earned points retained', connection });
      return { restored: true, points: restored };
    },
    async expireReservations() {
      const expired = await runInTransaction(connection => repository.expired({ connection, now: clock() }));
      for (const row of expired) await transaction({ shopId: row.shopid }, async connection => {
        const order = await repository.order({ shopId: row.shopid, orderId: row.order_id, connection });
        if (order && order.status === 'reserved' && Date.parse(order.reservation_expires_at) < clock().getTime()
          && !await repository.paymentBusy({ shopId: row.shopid, orderId: row.order_id, connection })) {
          await releaseIn({ shopId: row.shopid, orderId: row.order_id, connection, kind: 'expire' });
        }
      });
      return expired.length;
    },
  };
  return service;
};

module.exports = { buildLoyalty, buildSqlLoyaltyRepository };
