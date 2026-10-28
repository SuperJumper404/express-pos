const assert = require('assert/strict');
const { withDeliveryDatabase } = require('./helpers/deliveryDatabase');
const { buildLoyalty, buildSqlLoyaltyRepository } = require('../src/modules/m_loyalty');

async function run() {
  if (!process.env.DELIVERY_TEST_DATABASE_URL) {
    console.log('SKIP loyalty MySQL integration: explicit local disposable DELIVERY_TEST_DATABASE_URL required; no application credentials used');
    return;
  }
  await withDeliveryDatabase(async ({ pool, readRows, seedScenario }) => {
    await seedScenario();
    const runInTransaction = async work => {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await work(connection);
        await connection.commit(); return result;
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    };
    let now = new Date('2026-10-24T12:00:00Z');
    const loyalty = buildLoyalty({ repository: buildSqlLoyaltyRepository({ pool }), runInTransaction, clock: () => now });
    const paidTransaction = work => runInTransaction(async connection => {
      await connection.query('SELECT id FROM shop WHERE id=7 FOR UPDATE');
      return work(connection);
    });
    // Same verified global account, two existing per-restaurant profiles, two balances.
    const globalId = '3887c5bb-544c-4bc6-bd88-891bd894f901';
    await pool.query('INSERT INTO customer_accounts (id) VALUES (?)', [globalId]);
    await pool.query('UPDATE customers SET global_customer_id=? WHERE (shopid=7 AND id=51) OR (shopid=8 AND id=52)', [globalId]);
    const rewards = [{ id: 'coffee', name: 'Fixture reward', type: 'fixed', points: 30, value: 200 }];
    await loyalty.saveProgram({ shopId: 7, program: { enabled: true, name: 'Fixture 7', pointsPerEuro: 1, rewards } });
    await loyalty.saveProgram({ shopId: 8, program: { enabled: true, name: 'Fixture 8', pointsPerEuro: 10, rewards } });
    const alice = await loyalty.enroll({ shopId: 7, customerId: '51' });
    const elsewhere = await loyalty.enroll({ shopId: 8, customerId: '52' });
    assert.notEqual(alice.id, elsewhere.id);
    assert.notEqual(alice.qr, elsewhere.qr);
    const readded = await loyalty.enroll({ shopId: 7, customerId: '51' });
    assert.equal(readded.id, alice.id); assert.equal(readded.qr, alice.qr);
    await loyalty.adjust({ shopId: 7, memberId: alice.id, points: 50, reason: 'Fixture balance', actorId: 10 });
    assert.equal((await loyalty.getMember({ shopId: 8, customerId: '52' })).balance, 0);
    await assert.rejects(() => loyalty.lookup({ shopId: 8, qr: alice.qr }), error => error.status === 404);
    await assert.rejects(() => loyalty.getMember({ shopId: 8, memberId: alice.id }), error => error.status === 404);
    await assert.rejects(() => pool.query(`INSERT INTO loyalty_members (id,shopid,customer_id,qr) VALUES (UUID(),8,51,REPEAT('c',64))`), { code: 'ER_NO_REFERENCED_ROW_2' });

    await pool.query('UPDATE orders SET customer_account_id=51,subtotal=10 WHERE id=33 AND shopid=7');
    await pool.query(`INSERT INTO orders (id,shopid,ordernumber,customer,customerID,operator,subtotal,created,finished,customer_account_id)
      VALUES (34,7,'LOYALTY-34','Fixture',10,10,10,UTC_TIMESTAMP(),UTC_TIMESTAMP(),51)`);
    await pool.query(`INSERT INTO orderdetail (orderid,productid,price,qty,total,vat_rate,unit_price_ht,unit_vat,total_ht,total_vat)
      VALUES (33,21,5,2,10,10,4.55,0.45,9.09,0.91),(34,21,5,2,10,10,4.55,0.45,9.09,0.91)`);
    await loyalty.attach({ shopId: 7, orderId: 33, qr: alice.qr });
    await loyalty.attach({ shopId: 7, orderId: 34, qr: alice.qr });
    const attempts = await Promise.allSettled([33, 34].map(orderId => loyalty.reserve({ shopId: 7, orderId, rewardId: 'coffee', confirmed: true })));
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1, 'SQL locking permits only one spend of the same available points');
    assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.code === 'LOYALTY_INSUFFICIENT_POINTS').length, 1);
    const winner = attempts.find(result => result.status === 'fulfilled').value.orderId;
    const loser = winner === 33 ? 34 : 33;
    const beforePayment = await loyalty.getMember({ shopId: 7, customerId: '51' });
    assert.equal(beforePayment.balance, 50); assert.equal(beforePayment.reserved, 30);
    await paidTransaction(connection => loyalty.settlePaidOrder({ connection, shopId: 7, orderId: winner, paymentKey: 'fixture-paid', paidCents: 800 }));
    await paidTransaction(connection => loyalty.settlePaidOrder({ connection, shopId: 7, orderId: winner, paymentKey: 'fixture-paid', paidCents: 800 }));
    await paidTransaction(connection => loyalty.settlePaidOrder({ connection, shopId: 7, orderId: winner, paymentKey: 'fixture-another-event', paidCents: 800 }));
    assert.equal((await loyalty.getMember({ shopId: 7, customerId: '51' })).balance, 28);
    assert.equal((await readRows(`SELECT * FROM loyalty_ledger WHERE shopid=7 AND kind='earn' AND order_id=?`, [winner])).length, 1);
    const jobsBeforeRollback = (await readRows('SELECT * FROM loyalty_wallet_jobs')).length;
    await assert.rejects(() => paidTransaction(async connection => {
      await loyalty.settlePaidOrder({ connection, shopId: 7, orderId: loser, paymentKey: 'must-rollback', paidCents: 1000 });
      throw new Error('forced fixture rollback');
    }), /forced fixture rollback/);
    assert.equal((await loyalty.getMember({ shopId: 7, customerId: '51' })).balance, 28);
    assert.equal((await readRows('SELECT * FROM loyalty_wallet_jobs')).length, jobsBeforeRollback);
    assert.equal((await readRows("SELECT * FROM loyalty_ledger WHERE event_key LIKE '%must-rollback%' ")).length, 0);
    await paidTransaction(connection => loyalty.refundOrder({ connection, shopId: 7, orderId: winner, refundKey: 'fixture-half', refundedCents: 400 }));
    await paidTransaction(connection => loyalty.refundOrder({ connection, shopId: 7, orderId: winner, refundKey: 'fixture-half', refundedCents: 400 }));
    assert.equal((await loyalty.getMember({ shopId: 7, customerId: '51' })).balance, 43);
    await paidTransaction(connection => loyalty.refundOrder({ connection, shopId: 7, orderId: winner, refundKey: 'fixture-full', refundedCents: 400 }));
    assert.equal((await loyalty.getMember({ shopId: 7, customerId: '51' })).balance, 58, 'all spent points restored, eight earned points retained');
    await loyalty.reserve({ shopId: 7, orderId: loser, rewardId: 'coffee', confirmed: true });
    await paidTransaction(connection => loyalty.release({ connection, shopId: 7, orderId: loser }));
    assert.equal((await loyalty.getMember({ shopId: 7, customerId: '51' })).reserved, 0);
    assert.deepEqual(await paidTransaction(connection => loyalty.release({ connection, shopId: 7, orderId: 999 })), { released: false });
    // A reward applied during checkout changes real line prices/VAT; release restores them.
    const applied = await paidTransaction(connection => loyalty.applyCheckoutReward({ connection, shopId: 7, orderId: loser,
      customerId: '51', rewardId: 'coffee', confirmed: true }));
    assert.equal(applied.totalCents, 800);
    assert.equal(Number((await readRows('SELECT subtotal FROM orders WHERE id=?', [loser]))[0].subtotal), 8);
    const discounted = (await readRows('SELECT total,total_ht,total_vat FROM orderdetail WHERE orderid=?', [loser]))[0];
    assert.equal(Number(discounted.total), 8);
    assert.equal(Math.round((Number(discounted.total_ht) + Number(discounted.total_vat)) * 100), 800);
    now = new Date('2026-10-24T12:20:00Z');
    await loyalty.expireReservations();
    assert.equal(Number((await readRows('SELECT subtotal FROM orders WHERE id=?', [loser]))[0].subtotal), 10);
    assert.equal((await loyalty.getMember({ shopId: 7, customerId: '51' })).reserved, 0);
    assert((await readRows('SELECT * FROM loyalty_wallet_jobs WHERE shopid=7 AND member_id=?', [alice.id])).length > 1);
    console.log('PASS loyalty MySQL migrations, global identity/two restaurants, QR isolation, concurrent reservations, duplicate payment, refund, rollback, expiration, real price/VAT and outbox');
  });
}

run().catch(error => { console.error(error); process.exitCode = 1; });
