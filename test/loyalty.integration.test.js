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
    assert.match(alice.cardNumber, /^\d{16}$/);
    assert.equal(readded.cardNumber, alice.cardNumber);
    await pool.query("INSERT INTO customer_account_identities (channel,destination,account_id,verified_at) VALUES ('phone','+33612345678',?,UTC_TIMESTAMP())", [globalId]);
    assert.equal((await loyalty.lookup({ shopId: 7, kind: 'phone', value: '0612345678', countryCode: 'FR' })).id, alice.id);
    assert.equal((await loyalty.lookup({ shopId: 8, kind: 'phone', value: '+33612345678' })).id, elsewhere.id);
    await pool.query('UPDATE loyalty_members SET card_number=NULL WHERE id=?', [alice.id]);
    const { backfillCardNumbers } = require('../scripts/backfill-loyalty-card-numbers');
    assert.equal((await backfillCardNumbers({ pool })).updated, 1);
    assert.equal((await backfillCardNumbers({ pool })).updated, 0);
    assert.equal((await loyalty.getMember({ shopId: 7, customerId: '51' })).qr, alice.qr);
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
    // The real kiosk transaction reserves against the same member without customer authentication.
    now = new Date('2026-11-01T12:00:00Z');
    const [kiosk] = await pool.query("INSERT INTO service_points (shopid,name,type,is_active,created) VALUES (7,'Fixture kiosk','kiosk',1,UTC_TIMESTAMP())");
    const { buildCheckoutModule } = require('../src/modules/m_checkout');
    const checkout = buildCheckoutModule({ withTransaction: runInTransaction, loyalty, now: () => now });
    const input = { shopId: 7, sessionSubject: 'service_point', servicePointId: kiosk.insertId, orderSource: 'borne',
      customer: { name: 'Fixture', phone: '0612345678' }, items: [{ productId: 21, quantity: 1, selectedChoiceIds: [] }],
      expectedTotal: 12.5, paymentMode: 'stripe_terminal_kiosk', clientOrderToken: 'loyalty-sql-kiosk',
      loyaltyMemberId: alice.id, loyaltyRewardId: 'coffee', loyaltyConfirmed: true, loyaltyExpectedDiscountCents: 200,
      loyaltyExpectedPointsCost: 30, loyaltyProgramVersion: (await loyalty.getProgram({ shopId: 7 })).version };
    await assert.rejects(checkout.createCheckout({ ...input, loyaltyExpectedDiscountCents: 100 }), { code: 'LOYALTY_REQUOTE_REQUIRED' });
    assert.equal((await readRows('SELECT id FROM orders WHERE client_order_token=?', [input.clientOrderToken])).length, 0);
    const created = await checkout.createCheckout(input);
    assert.equal(created.total, 10.5);
    assert.equal((await checkout.createCheckout(input)).idempotent_replay, true);
    await paidTransaction(connection => loyalty.settlePaidOrder({ connection, shopId: 7, orderId: created.orderId, paymentKey: 'kiosk-fixture', paidCents: 1050 }));
    await paidTransaction(connection => loyalty.settlePaidOrder({ connection, shopId: 7, orderId: created.orderId, paymentKey: 'kiosk-fixture', paidCents: 1050 }));
    assert.equal((await loyalty.getMember({ shopId: 7, customerId: '51' })).balance, 38);
    // Freeze a registered Apple audience, then withdraw consent before worker processing.
    await loyalty.setMarketingConsent({ shopId: 7, customerId: '51', marketingConsent: true });
    const serial = '00000000-0000-4000-8000-000000000099';
    await pool.query("INSERT INTO loyalty_wallet_passes (serial,shopid,member_id,provider,auth_token) VALUES (?,7,?,'apple',REPEAT('a',64))", [serial, alice.id]);
    await pool.query("INSERT INTO loyalty_wallet_registrations (serial,device_id,push_token) VALUES (?,'fixture-device','fixture-push')", [serial]);
    const { buildLoyaltyCampaigns, buildSqlCampaignRepository } = require('../src/modules/m_loyaltyCampaigns');
    const campaigns = buildLoyaltyCampaigns({ repository: buildSqlCampaignRepository({ pool }), runInTransaction });
    const draft = await campaigns.createDraft({ shopId: 7, actorId: 10, requestId: '00000000-0000-4000-8000-000000000098', message: 'Fixture only', target: { type: 'all' } });
    assert.equal(draft.recipientCount, 1);
    await runInTransaction(connection => buildSqlCampaignRepository({ pool }).queue({ shopId: 7, campaignId: draft.id, now, connection }));
    await loyalty.setMarketingConsent({ shopId: 7, customerId: '51', marketingConsent: false });
    const jobs = require('../src/services/loyaltyCampaignWorker').buildSqlCampaignJobs({ pool });
    const job = await jobs.claim(); assert.equal(job.memberId, alice.id);
    assert.equal(await jobs.prepare(job), false);
    await jobs.complete(job, 'skipped');
    assert.equal((await readRows('SELECT status FROM loyalty_wallet_campaign_recipients WHERE campaign_id=?', [draft.id]))[0].status, 'skipped');
    assert.equal((await readRows('SELECT wallet_message FROM loyalty_members WHERE id=?', [alice.id]))[0].wallet_message, '');
    console.log('PASS loyalty MySQL migrations, lookup/backfill, isolation, concurrent reservations, payment/refund/rollback, kiosk discount/replay and frozen campaign consent');
  });
}

run().catch(error => { console.error(error); process.exitCode = 1; });
