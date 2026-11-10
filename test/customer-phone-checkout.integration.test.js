const assert = require('node:assert/strict');
const { test } = require('node:test');
const { withDeliveryDatabase } = require('./helpers/deliveryDatabase');

test('SQL cashier/table phone attribution, payment once, enrollment reuse, archive and private detail',
  { skip: !process.env.DELIVERY_TEST_DATABASE_URL }, async () => {
    await withDeliveryDatabase(async ({ pool, readRows, seedScenario }) => {
      await seedScenario();
      // Every application query is bound to the disposable database, including legacy imports.
      require.cache[require.resolve('../src/config/dbPool')] = { exports: pool };
      require.cache[require.resolve('../src/config/db')] = { exports: { query: () => { throw new Error('legacy SQL not expected'); } } };
      if (Number(process.versions.node.split('.')[0]) < 22) require.cache[require.resolve('nanoid')] = { exports: await import('nanoid') };
      const { buildCheckoutModule } = require('../src/modules/m_checkout');
      const { buildCustomerPhoneService, buildSqlCustomerPhoneRepository } = require('../src/modules/m_customerPhone');
      const { buildLoyalty, buildSqlLoyaltyRepository } = require('../src/modules/m_loyalty');
      const { buildOrderArchiveModule } = require('../src/modules/m_orders');
      const { buildDetailOrderController } = require('../src/controllers/c_orders');
      const transaction = async work => {
        const connection = await pool.getConnection();
        try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; }
        catch (error) { await connection.rollback(); throw error; }
        finally { connection.release(); }
      };
      const customerPhone = buildCustomerPhoneService({ repository: buildSqlCustomerPhoneRepository({ pool }), runInTransaction: transaction });
      const loyalty = buildLoyalty({ repository: buildSqlLoyaltyRepository({ pool }), runInTransaction: transaction, customerPhone });
      const checkout = buildCheckoutModule({ withTransaction: transaction, customerPhone, loyalty });
      const archive = buildOrderArchiveModule({ withTransaction: transaction, loyalty, createToken: () => 'phone-checkout-public-ticket' });
      await pool.query('UPDATE users SET module_permissions=? WHERE shopid=7 AND id=10', [JSON.stringify(['orders', 'cashregister', 'history'])]);
      await pool.query(`INSERT INTO service_points (id,shopid,name,type,system_key,is_active,created) VALUES
        (70,7,'Phone counter','counter','counter',1,NOW()),(71,7,'Phone table','table',NULL,1,NOW())`);
      await pool.query('UPDATE products SET track_stock=0 WHERE id=21');
      await loyalty.saveProgram({ shopId: 7, program: { enabled: true, pointsPerEuro: 1 } });
      const base = { shopId: 7, sessionSubject: 'staff', actorId: 10, servicePointId: 70, orderSource: 'pos',
        customer: { id: 10, name: 'Phone fixture', phone: '0612345678' }, items: [{ productId: 21, quantity: 1, selectedChoiceIds: [] }],
        expectedTotal: 12.5, paymentMode: 'paiement au comptoir', clientOrderToken: 'phone-sql-profile', customer_profile_id: '51' };
      const counts = async () => Object.fromEntries(await Promise.all(['customers', 'loyalty_members', 'loyalty_ledger', 'customer_identities', 'customer_accounts', 'customer_sessions']
        .map(async table => [table, Number((await readRows(`SELECT COUNT(*) AS total FROM ${table}`))[0].total)])));
      const before = await counts();
      const attempts = await Promise.all([checkout.createCheckout(base), checkout.createCheckout(base)]);
      const guest = attempts[0];
      assert.equal(attempts.filter(result => result.idempotent_replay).length, 1);
      assert.equal(attempts[0].orderId, attempts[1].orderId);
      const [guestOrder] = await readRows('SELECT *,CAST(customer_profile_id AS CHAR) AS profileId FROM orders WHERE id=?', [guest.orderId]);
      assert.ok(guestOrder.profileId); assert.notEqual(guestOrder.profileId, '51'); assert.equal(guestOrder.customer_account_id, null);
      const after = await counts(); assert.equal(after.customers, before.customers + 1);
      for (const table of ['loyalty_members', 'loyalty_ledger', 'customer_identities', 'customer_accounts', 'customer_sessions']) assert.equal(after[table], before[table], table);
      // Once the response is lost, later phone reassignment must not affect its replay.
      await transaction(async connection => {
        await connection.query("UPDATE customers SET contact_phone='' WHERE shopid=7 AND id=?", [guestOrder.profileId]);
        // Disposable fixture only: remove audit children before their FK-protected mapping.
        const [events] = await connection.query(`DELETE e FROM customer_directory_events e
          JOIN customer_directory_contacts c ON c.shopid=e.shopid AND c.contact_key=e.contact_key
          WHERE c.shopid=7 AND c.customer_id=?`, [guestOrder.profileId]);
        assert.equal(events.affectedRows, 1, 'the original resolution created one mapping audit');
        const [contacts] = await connection.query('DELETE FROM customer_directory_contacts WHERE shopid=7 AND customer_id=?', [guestOrder.profileId]);
        assert.equal(contacts.affectedRows, 1, 'the phone is unbound before its accepted checkout is replayed');
      });
      assert.equal((await checkout.createCheckout(base)).idempotent_replay, true);
      assert.deepEqual(await counts(), after);
      assert.equal((await readRows('SELECT CAST(customer_profile_id AS CHAR) AS id FROM orders WHERE id=?', [guest.orderId]))[0].id, guestOrder.profileId);

      const known = await customerPhone.resolve({ shopId: 7, phone: '0623456789', name: 'Existing guest' });
      const enrolled = await loyalty.enrollPhone({ shopId: 7, phone: '+33623456789' });
      assert.equal(enrolled.customerId, known.customer.id, 'explicit card enrollment reuses the unverified profile');
      await loyalty.adjust({ shopId: 7, memberId: enrolled.member.id, points: 40, reason: 'Fixture opening balance', actorId: 10 });
      const qrInput = { ...base, sessionSubject: 'service_point', actorId: null, servicePointId: 71, orderSource: 'table_qr',
        customer: { name: 'Table fixture', phone: '0623456789' }, paymentMode: 'stripe', clientOrderToken: 'phone-sql-table' };
      const qr = await checkout.createCheckout(qrInput);
      const [qrOrder] = await readRows('SELECT *,CAST(customer_profile_id AS CHAR) AS profileId FROM orders WHERE id=?', [qr.orderId]);
      assert.equal(qrOrder.profileId, known.customer.id); assert.equal(qrOrder.customer_account_id, null);
      assert.equal((await readRows("SELECT * FROM loyalty_ledger WHERE kind='earn' AND order_id=?", [qr.orderId])).length, 0);
      assert.equal((await customerPhone.getSummary({ shopId: 7, customerId: known.customer.id })).loyalty.balance, 40);
      await transaction(async connection => {
        await connection.query('SELECT id FROM shop WHERE id=7 FOR UPDATE');
        await connection.query("UPDATE orders SET payment_status='paid' WHERE id=?", [qr.orderId]);
        const scope = { connection, shopId: 7, orderId: qr.orderId, paymentKey: 'stripe:phone-fixture', paidCents: 1250 };
        await loyalty.settlePaidOrder(scope); await loyalty.settlePaidOrder(scope);
      });
      assert.equal((await customerPhone.getSummary({ shopId: 7, customerId: known.customer.id })).loyalty.balance, 52);
      assert.equal((await readRows("SELECT * FROM loyalty_ledger WHERE kind='earn' AND order_id=?", [qr.orderId])).length, 1);
      assert.equal((await readRows("SELECT * FROM loyalty_ledger WHERE kind='spend' AND order_id=?", [qr.orderId])).length, 0);
      const paidInput = { ...base, customer: qrInput.customer, paymentMode: 'counter_pay_before:Espèces', clientOrderToken: 'phone-sql-paid-counter' };
      const paid = await checkout.createCheckout(paidInput);
      assert.equal((await checkout.createCheckout(paidInput)).idempotent_replay, true);
      assert.equal((await customerPhone.getSummary({ shopId: 7, customerId: known.customer.id })).loyalty.balance, 64);
      await archive.mArchiveOrder(paid.orderId, undefined, 7, {}, 10);
      const [archived] = await readRows('SELECT *,CAST(customer_profile_id AS CHAR) AS profileId FROM archives WHERE token=?', ['phone-checkout-public-ticket']);
      assert.equal(archived.profileId, known.customer.id); assert.equal(archived.customer_account_id, null);
      assert.equal((await customerPhone.getSummary({ shopId: 7, customerId: known.customer.id })).loyalty.balance, 64, 'archive cannot credit the paid order again');
      const res = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
      const req = { params: { id: archived.id }, id: 10, shopid: 7, sessionSubject: 'staff', access: 1,
        currentUser: { id: 10, shopid: 7, access: 1, status: 1, module_permissions: ['orders'] } };
      const staffResponse = res(); await buildDetailOrderController({ archived: true, customerPhone })(req, staffResponse);
      assert.equal(staffResponse.statusCode, 200); assert.equal(staffResponse.body.data[0].clientProfile.customer.id, known.customer.id);
      assert.equal(staffResponse.body.data[0].clientProfile.loyalty.available, 64);
      const otherResponse = res(); await buildDetailOrderController({ archived: true, customerPhone })({ ...req, shopid: 8,
        currentUser: { ...req.currentUser, shopid: 8 } }, otherResponse);
      assert.equal(otherResponse.body.data[0].clientProfile, undefined, 'legacy foreign-shop non-delivery archive read has no summary');
      const publicRows = await archive.mDetailArchivedOrderByToken('phone-checkout-public-ticket');
      assert.equal(publicRows[0].clientProfile, undefined); assert.equal(publicRows[0].customer_profile_id, undefined);
    });
  });
