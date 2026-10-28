const assert = require('assert/strict');
const { buildLoyaltyWalletWorker } = require('../src/services/loyaltyWalletWorker');

(async () => {
  const events = []; let jobs = [{ id: '1', shopid: 7, member_id: 'member', attempts: 0 }]; let fail = true;
  const repository = { claim: async () => jobs.shift(), complete: async id => events.push(['done', id]),
    retry: async (id, attempts, delay, code) => events.push(['retry', id, attempts, delay, code]) };
  const wallet = { synchronizeMember: async scope => { events.push(['sync', scope]); if (fail) throw new Error('private provider response'); } };
  const worker = buildLoyaltyWalletWorker({ repository, wallet });
  await worker.run();
  assert.deepEqual(events[0], ['sync', { shopId: 7, memberId: 'member' }]);
  assert.deepEqual(events[1], ['retry', '1', 1, 30, 'WALLET_SYNC_FAILED']);
  assert.equal(JSON.stringify(events).includes('private'), false);
  jobs = [{ id: '1', shopid: 7, member_id: 'member', attempts: 1 }]; fail = false;
  await worker.run(); assert.deepEqual(events.at(-1), ['done', '1']);
  // One maintenance invocation at a time; no duplicate work from a slow provider.
  let release; jobs = [{ id: '2', shopid: 7, member_id: 'member', attempts: 0 }];
  wallet.synchronizeMember = () => new Promise(resolve => { release = resolve; });
  const running = worker.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await worker.run(), 0); release(); await running;
  console.log('loyalty wallet worker: retries, safe errors, completion and single-flight passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
