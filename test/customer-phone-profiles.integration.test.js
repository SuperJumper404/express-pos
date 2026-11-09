const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { withDeliveryDatabase } = require('./helpers/deliveryDatabase');
const { buildCustomerPhoneService, buildSqlCustomerPhoneRepository } = require('../src/modules/m_customerPhone');
const migration = fs.readFileSync(path.join(__dirname, '../db/migrations/20261109120000_customer_phone_profiles.sql'), 'utf8');
const [, up, down] = migration.split(/^-- migrate:(?:up|down)\s*$/m);
const hash = phone => createHash('sha256').update(phone).digest('hex');

test('additive profile migration has scoped FKs and preserves canonical contacts on rollback', () => {
  assert(up && down);
  for (const table of ['orders', 'archives']) assert.match(up, new RegExp(`ALTER TABLE ${table}[\\s\\S]*?FOREIGN KEY \\(shopid,customer_profile_id\\) REFERENCES customers\\(shopid,id\\)`));
  assert.match(up, /'manual','phone'/);
  assert(down.indexOf("SET match_kind='manual'") < down.indexOf('ADD CONSTRAINT chk_directory_match'));
  assert.doesNotMatch(down, /DELETE FROM|DROP TABLE|TRUNCATE/);
});

test('MySQL phone resolution: concurrency, canonical aliases, tenants, no membership, migration round trip', { skip: !process.env.DELIVERY_TEST_DATABASE_URL && 'explicit local disposable DELIVERY_TEST_DATABASE_URL required; application credentials are never used' }, async () => {
  await withDeliveryDatabase(async ({ pool, seedScenario, readRows }) => {
    await seedScenario();
    const transaction = async work => {
      const connection = await pool.getConnection();
      try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    };
    const service = buildCustomerPhoneService({ repository: buildSqlCustomerPhoneRepository({ pool }), runInTransaction: transaction });
    const counts = async () => {
      const names = ['customers','loyalty_members','loyalty_ledger','customer_identities','customer_account_identities','customer_accounts','customer_sessions','customer_directory_contacts','customer_directory_events'];
      return Object.fromEntries(await Promise.all(names.map(async table => [table, Number((await readRows(`SELECT COUNT(*) AS total FROM ${table}`))[0].total)])));
    };
    const baseline = await counts();
    const results = await Promise.all(['06 12 34 56 78', '+33612345678', '06.12.34.56.78', '+33 6 12 34 56 78'].map(phone => service.resolve({ shopId: 7, phone, name: 'Concurrent guest' })));
    const profile = results[0].customer;
    assert.equal(new Set(results.map(r => r.customer.id)).size, 1);
    assert.equal(results.filter(r => r.created).length, 1);
    assert(results.every(r => r.loyalty === null));
    const after = await counts();
    for (const table of ['loyalty_members','loyalty_ledger','customer_identities','customer_account_identities','customer_accounts','customer_sessions']) assert.equal(after[table], baseline[table], `${table} unchanged by resolution`);
    assert.equal(after.customers, baseline.customers + 1); assert.equal(after.customer_directory_contacts, 1); assert.equal(after.customer_directory_events, 1);
    const [[stored]] = await pool.query('SELECT name,contact_phone,contact_email,global_customer_id FROM customers WHERE id=?', [profile.id]);
    assert.deepEqual(stored, { name: 'Concurrent guest', contact_phone: '+33612345678', contact_email: '', global_customer_id: null });
    const other = await service.resolve({ shopId: 8, phone: '0612345678' });
    assert.notEqual(other.customer.id, profile.id);
    assert.equal(await service.getSummary({ shopId: 8, customerId: profile.id }), null);
    await pool.query('UPDATE orders SET customer_profile_id=? WHERE shopid=7 AND id=33', [profile.id]);
    await pool.query('UPDATE archives SET customer_profile_id=? WHERE shopid=7 AND id=32', [profile.id]);
    await assert.rejects(pool.query('UPDATE orders SET customer_profile_id=? WHERE shopid=7 AND id=33', [other.customer.id]), { code: 'ER_NO_REFERENCED_ROW_2' });
    await assert.rejects(pool.query('UPDATE archives SET customer_profile_id=? WHERE shopid=7 AND id=32', [other.customer.id]), { code: 'ER_NO_REFERENCED_ROW_2' });

    // A transaction may already have an older checkout snapshot when it gets the Shop lock.
    await transaction(async connection => {
      await connection.query('SELECT COUNT(*) FROM customers WHERE shopid=7');
      const concurrent = await service.resolve({ shopId: 7, phone: '0623456789' });
      const current = await service.resolve({ shopId: 7, phone: '+33623456789', connection });
      assert.equal(current.customer.id, concurrent.customer.id); assert.equal(current.created, false);
    });
    await pool.query("INSERT INTO customers (id,shopid,name,contact_phone) VALUES (1001,7,'Legacy','06 34 56 78 90')");
    assert.equal((await service.resolve({ shopId: 7, phone: '+33634567890', name: 'Do not change' })).customer.name, 'Legacy');
    const accountId = '3887c5bb-544c-4bc6-bd88-891bd894f902';
    await pool.query('INSERT INTO customer_accounts (id) VALUES (?)', [accountId]);
    await pool.query("INSERT INTO customers (id,shopid,name,global_customer_id) VALUES (1002,7,'Global',?)", [accountId]);
    await pool.query("INSERT INTO customer_account_identities (channel,destination,account_id,verified_at) VALUES ('phone','+33645678901',?,UTC_TIMESTAMP())", [accountId]);
    assert.equal((await service.resolve({ shopId: 7, phone: '0645678901' })).customer.id, '1002');
    await pool.query("INSERT INTO customers (id,shopid,name) VALUES (1003,7,'Member')");
    await pool.query("INSERT INTO loyalty_members (id,shopid,customer_id,qr,phone_e164,card_number,balance,reserved) VALUES (UUID(),7,1003,REPEAT('f',64),'+33656789012','1234567890123456',45,7)");
    await pool.query("INSERT INTO loyalty_programs (shopid,config) VALUES (7,?)", [JSON.stringify({ enabled: false })]);
    const memberCounts = await counts();
    const member = await service.resolve({ shopId: 7, phone: '0656789012' });
    assert.equal(member.customer.id, '1003'); assert.equal(member.loyalty.available, 38); assert.equal(member.loyalty.cardNumber, '1234567890123456');
    const memberAfter = await counts();
    for (const table of ['customers','loyalty_members','loyalty_ledger','customer_identities','customer_accounts','customer_sessions']) assert.equal(memberAfter[table], memberCounts[table]);
    await pool.query("INSERT INTO customers (id,shopid,name,contact_phone) VALUES (1004,7,'Import','0667890123'),(1005,7,'Verified','')");
    await pool.query("INSERT INTO customer_identities (shopid,customer_id,channel,destination,verified_at) VALUES (7,1005,'sms','+33667890123',UTC_TIMESTAMP())");
    await pool.query("INSERT INTO customer_directory_contacts (shopid,contact_key,customer_id,source_customer_id,match_kind) VALUES (7,?,1004,1004,'import')", [hash('+33667890123')]);
    assert.equal((await service.resolve({ shopId: 7, phone: '0667890123' })).customer.id, '1005');
    assert.equal((await service.resolve({ shopId: 7, phone: '+33667890123' })).customer.id, '1005');
    await pool.query("INSERT INTO customers (id,shopid,name,contact_phone) VALUES (1006,7,'Alias','0678901234'),(1007,7,'Canonical','')");
    await pool.query("INSERT INTO customer_directory_contacts (shopid,contact_key,customer_id,source_customer_id,match_kind) VALUES (7,?,1007,1006,'manual')", [hash('+33678901234')]);
    const beforeManual = await counts();
    assert.equal((await service.resolve({ shopId: 7, phone: '0678901234' })).customer.id, '1007');
    assert.deepEqual(await counts(), beforeManual, 'confirmed manual mapping is not rewritten/audited on lookup');
    await pool.query("INSERT INTO customers (id,shopid,name,contact_phone) VALUES (1008,7,'Conflict A','0689012345'),(1009,7,'Conflict B','+33689012345')");
    const beforeAmbiguous = await counts();
    const conflict = await service.resolve({ shopId: 7, phone: '0689012345' });
    assert.equal(conflict.status, 'ambiguous'); assert.equal(conflict.customer, null); assert.deepEqual(await counts(), beforeAmbiguous);
    const beforeSummary = await counts();
    await service.getSummary({ shopId: 7, customerId: member.customer.id }); assert.deepEqual(await counts(), beforeSummary);
    const contactsBeforeRollback = (await readRows('SELECT id FROM customers')).length;
    await pool.query(down);
    assert.equal((await readRows('SELECT id FROM customers')).length, contactsBeforeRollback);
    assert.equal((await readRows("SELECT match_kind FROM customer_directory_contacts WHERE shopid=7 AND contact_key=?", [hash('+33612345678')]))[0].match_kind, 'manual');
    await assert.rejects(pool.query("UPDATE customer_directory_contacts SET match_kind='phone' WHERE shopid=7"));
    await pool.query(up);
    assert.equal((await service.resolve({ shopId: 7, phone: '0612345678' })).customer.id, profile.id);
    const { buildSqlClientDirectoryRepository } = require('../src/modules/m_clientDirectory');
    const sources = await buildSqlClientDirectoryRepository({ pool }).loadSources({ shopId: 7 });
    assert(sources.customers.some(c => c.id === profile.id));
  });
});

test('MySQL old checkout snapshots preserve concurrently committed imported-source protection', { skip: !process.env.DELIVERY_TEST_DATABASE_URL && 'explicit local disposable DELIVERY_TEST_DATABASE_URL required; application credentials are never used' }, async () => {
  await withDeliveryDatabase(async ({ pool, seedScenario, readRows }) => {
    await seedScenario();
    const transaction = async work => {
      const connection = await pool.getConnection();
      try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    };
    const service = buildCustomerPhoneService({ repository: buildSqlCustomerPhoneRepository({ pool }), runInTransaction: transaction });
    const scenarios = [
      { table: 'customer_addresses', column: 'customer_id', phone: '+33690123456' },
      { table: 'orders', column: 'customer_account_id', phone: '+33691234567' },
      { table: 'orders', column: 'customer_profile_id', phone: '+33692345678' },
      { table: 'archives', column: 'customer_account_id', phone: '+33693456789' },
      { table: 'archives', column: 'customer_profile_id', phone: '+33694567890' },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const source = String(2001 + index * 2), target = String(2002 + index * 2), contactKey = hash(scenario.phone);
      await pool.query('INSERT INTO customers (id,shopid,name,contact_phone) VALUES (?,7,?,?),(?,7,?,?)', [source, 'Imported source', scenario.phone, target, 'Verified target', '']);
      await pool.query("INSERT INTO customer_identities (shopid,customer_id,channel,destination,verified_at) VALUES (7,?,'sms',?,UTC_TIMESTAMP())", [target, scenario.phone]);
      await pool.query("INSERT INTO customer_directory_contacts (shopid,contact_key,customer_id,source_customer_id,match_kind) VALUES (7,?,?,?,'import')", [contactKey, source, source]);
      await transaction(async checkoutConnection => {
        // Establish the old consistent-read snapshot before the new protection is committed.
        const query = `SELECT COUNT(*) AS total FROM ${scenario.table} WHERE shopid=7 AND ${scenario.column}=?`;
        assert.equal(Number((await checkoutConnection.query(query, [source]))[0][0].total), 0);
        await transaction(async writer => {
          await writer.query('SELECT id FROM shop WHERE id=7 FOR UPDATE');
          await writer.query('SELECT id FROM customers WHERE shopid=7 AND id=? FOR UPDATE', [source]);
          if (scenario.table === 'customer_addresses') await writer.query('INSERT INTO customer_addresses (shopid,customer_id,label_number,address_snapshot) VALUES (7,?,1,?)', [source, JSON.stringify({ line1: '1 rue Test' })]);
          else await writer.query(`UPDATE ${scenario.table} SET ${scenario.column}=? WHERE shopid=7 AND id=?`, [source, scenario.table === 'orders' ? 33 : 32]);
        });
        assert.equal(Number((await checkoutConnection.query(query, [source]))[0][0].total), 0, 'ordinary reads still see the old snapshot');
        const result = await service.resolve({ shopId: 7, phone: scenario.phone, connection: checkoutConnection });
        assert.equal(result.status, 'ambiguous', `${scenario.table}.${scenario.column} protects the imported source`);
        assert.equal(result.customer, null); assert.equal(result.created, false);
      });
      const [binding] = await readRows('SELECT CAST(customer_id AS CHAR) AS customer_id,match_kind FROM customer_directory_contacts WHERE shopid=7 AND contact_key=?', [contactKey]);
      assert.deepEqual(binding, { customer_id: source, match_kind: 'import' });
      assert.equal((await readRows('SELECT id FROM customer_directory_events WHERE shopid=7 AND contact_key=?', [contactKey])).length, 0);
    }
  });
});
