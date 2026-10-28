const assert = require('assert/strict');
const { buildSqlWalletRepository } = require('../src/services/loyaltyWallet');

// SQL-boundary double exercises the real repository and rejects unrecognized statements.
const fixture = () => {
  let revision = 0n; let transaction = false; let released = 0; const passes = [];
  const connection = {
    beginTransaction: async () => { assert.equal(transaction, false); transaction = true; },
    commit: async () => { assert.equal(transaction, true); transaction = false; },
    rollback: async () => { transaction = false; },
    release: () => { released++; },
    async query(sql, values = []) {
      const query = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT CAST\(revision AS CHAR\) AS revision FROM loyalty_wallet_sequence WHERE id=1 FOR UPDATE$/.test(query)) { assert.equal(transaction, true); return [[{ revision: revision.toString() }]]; }
      if (/^UPDATE loyalty_wallet_sequence SET revision=\? WHERE id=1$/.test(query)) { revision = BigInt(values[0]); return [{ affectedRows: 1 }]; }
      if (/^SELECT \* FROM loyalty_wallet_passes WHERE shopid=\? AND member_id=\? AND provider=\?$/.test(query)) return [[...passes.filter(row => row.shopid === values[0] && row.member_id === values[1] && row.provider === values[2])]];
      if (/^INSERT INTO loyalty_wallet_passes/.test(query)) {
        const [serial, shopid, member_id, provider, auth_token, updated_tag] = values;
        passes.push({ serial, shopid, member_id, provider, auth_token, updated_tag }); return [{ affectedRows: 1 }];
      }
      if (/^UPDATE loyalty_wallet_passes SET updated_tag=\?,updated_at=UTC_TIMESTAMP\(3\) WHERE serial=\?$/.test(query)) { passes.find(row => row.serial === values[1]).updated_tag = values[0]; return [{ affectedRows: 1 }]; }
      if (/^SELECT p.serial,CAST\(p.updated_tag AS CHAR\)/.test(query)) return [[...passes.filter(row => row.provider === 'apple' && BigInt(row.updated_tag) > BigInt(values[1])).sort((a, b) => BigInt(a.updated_tag) < BigInt(b.updated_tag) ? -1 : 1)]];
      throw new Error(`Unexpected SQL: ${query}`);
    },
  };
  const pool = { getConnection: async () => connection, query: (...args) => connection.query(...args) };
  return { pool, passes, get revision() { return revision; }, get released() { return released; } };
};

(async () => {
  const originalNow = Date.now; Date.now = () => 1000;
  try {
    const state = fixture(); const repo = buildSqlWalletRepository({ pool: state.pool });
    const a = await repo.ensurePass({ shopId: 1, member: { id: 'a' }, provider: 'apple' });
    const b = await repo.ensurePass({ shopId: 2, member: { id: 'b' }, provider: 'apple' });
    assert.equal(a.updated_tag, '1'); assert.equal(b.updated_tag, '2');
    const again = await repo.ensurePass({ shopId: 1, member: { id: 'a' }, provider: 'apple' });
    assert.equal(again.serial, a.serial); assert.equal(again.auth_token, a.auth_token); assert.equal(state.revision, 2n);
    await repo.markUpdated(a.serial); const cursor = state.passes.find(row => row.serial === a.serial).updated_tag;
    await repo.markUpdated(b.serial);
    const updates = await repo.updated({ deviceId: 'device', since: cursor });
    assert.deepEqual(updates.map(row => row.serial), [b.serial], 'same-clock updates on a second pass must not be lost after a device cursor');
    assert.equal(updates[0].updated_tag, '4'); assert.equal(state.released, 5);
    console.log('loyalty wallet tags: global monotone SQL sequence, same-clock multi-pass updates and stable re-add passed');
  } finally { Date.now = originalNow; }
})().catch(error => { console.error(error); process.exitCode = 1; });
