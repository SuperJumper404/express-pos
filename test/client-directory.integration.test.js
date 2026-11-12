const assert = require('assert/strict');
const { withDeliveryDatabase } = require('./helpers/deliveryDatabase');
const { buildClientDirectoryService, buildSqlClientDirectoryRepository } = require('../src/modules/m_clientDirectory');
async function run() {
  if (!process.env.DELIVERY_TEST_DATABASE_URL) {
    console.log('SKIP client directory MySQL integration: explicit local disposable DELIVERY_TEST_DATABASE_URL required; application credentials are never used');
    return;
  }
  await withDeliveryDatabase(async ({ pool, seedScenario, readRows }) => {
    await seedScenario();
    await pool.query("UPDATE archives SET phone='06 12 34 56 78',customer='Alice',subtotal=8 WHERE id=32 AND shopid=7");
    await pool.query(`INSERT INTO customer_identities (shopid,customer_id,channel,destination,verified_at,created_at)
      VALUES (7,51,'sms','+33612345678',UTC_TIMESTAMP(),UTC_TIMESTAMP())`);
    await pool.query(`INSERT INTO loyalty_members (id,shopid,customer_id,qr,balance,reserved)
      VALUES ('5887c5bb-544c-4bc6-bd88-891bd894f901',7,51,REPEAT('d',64),50,10)`);
    await pool.query(`INSERT INTO archives
      (id,shopid,ordernumber,customer,customerID,operator,phone,subtotal,created,finished,token,is_takeaway,customer_account_id)
      VALUES (42,7,'EXPLICIT-42','Alice',10,10,'555',12,'2026-11-01 12:00:00','2026-11-01 12:00:00','explicit-42',0,51),
      (43,7,'LEGACY-43','Ancien',10,10,'555',4,'2026-11-02 12:00:00','2026-11-02 12:00:00','legacy-43',0,NULL)`);
    const runInTransaction = async work => {
      const connection = await pool.getConnection();
      try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    };
    const service = buildClientDirectoryService({ repository: buildSqlClientDirectoryRepository({ pool }), runInTransaction });
    const scope = { shopId: 7, canManageLoyalty: true };
    const originalArchives = await readRows('SELECT * FROM archives ORDER BY id');
    const originalMembers = await readRows('SELECT * FROM loyalty_members ORDER BY id');
    const originalIdentities = await readRows('SELECT * FROM customer_identities ORDER BY id');
    const first = await service.list(scope);
    const old = first.items.find(row => row.phone === '555');
    assert.equal(first.items.find(row => row.id === '51').orderCount, 2);
    await service.reconcile({ shopId: 7, actorId: 10, dryRun: true });
    assert.equal((await readRows('SELECT * FROM customer_directory_contacts')).length, 0);
    await Promise.all([1, 2].map(() => service.reconcile({ shopId: 7, actorId: 10, dryRun: false })));
    assert.equal((await readRows('SELECT * FROM customer_directory_contacts WHERE shopid=7')).length, 2);
    assert.equal((await readRows('SELECT * FROM customers WHERE shopid=7')).length, 2, 'only one imported profile despite concurrent import');
    assert.equal((await readRows('SELECT * FROM customer_directory_events WHERE shopid=7')).length, 2, 'replay does not add audit noise');
    await assert.rejects(() => pool.query(`INSERT INTO customer_directory_contacts (shopid,contact_key,customer_id,match_kind) VALUES (8,REPEAT('e',64),51,'manual')`), { code: 'ER_NO_REFERENCED_ROW_2' });
    await service.linkContact({ shopId: 7, actorId: 10, contactKey: old.contactKeys[0], customerId: '51' });
    const after = await service.detail({ ...scope, id: old.id });
    assert.equal(after.client.id, '51'); assert.equal(after.client.totalSpent, 24); assert.equal(after.orders.length, 3);
    assert.deepEqual(await readRows('SELECT * FROM archives ORDER BY id'), originalArchives);
    assert.deepEqual(await readRows('SELECT * FROM loyalty_members ORDER BY id'), originalMembers);
    assert.deepEqual(await readRows('SELECT * FROM customer_identities ORDER BY id'), originalIdentities);
    assert.equal((await service.list({ shopId: 8, canManageLoyalty: true })).items.some(row => row.id === '51'), false);
    console.log('PASS client directory SQL migration, concurrent/replayed import, tenant foreign keys, aliases and preservation of archives, identities and points');
  });
}
run().catch(error => { console.error(error); process.exitCode = 1; });
