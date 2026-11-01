const assert = require('node:assert/strict');
const { test } = require('node:test');
let workers = {};
try { workers = require('../src/services/loyaltyCampaignWorker'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
test('campaign worker skips ineligible cards, retries provider errors and carries the claimed lease', async () => {
  assert.equal(typeof workers.buildLoyaltyCampaignWorker, 'function');
  const jobs = [{ campaignId: '1', memberId: 'opted-out', shopId: 7, lease: 'first', attempts: 0 },
    { campaignId: '2', memberId: 'active', shopId: 7, lease: 'second', attempts: 0 }];
  const completed = []; const retried = []; let sent = 0;
  const repository = { claim: async () => jobs.shift(), prepare: async job => job.memberId === 'active',
    complete: async (job, status) => completed.push({ job, status }), retry: async (job, delay) => retried.push({ job, delay }) };
  const worker = workers.buildLoyaltyCampaignWorker({ repository, wallet: { synchronizeMember: async input => { assert.equal(input.provider, 'apple'); sent++; throw new Error('private provider details'); } } });
  assert.equal(await worker.run(), 2); assert.equal(sent, 1);
  assert.equal(completed[0].status, 'skipped'); assert.equal(completed[0].job.lease, 'first');
  assert.equal(retried[0].delay, 30); assert.equal(retried[0].job.lease, 'second');
});
test('campaign worker marks only provider-processed cards and does not claim notification reading', async () => {
  assert.equal(typeof workers.buildLoyaltyCampaignWorker, 'function');
  let job = { campaignId: '9007199254740993', memberId: 'active', shopId: 7, lease: 'lease', attempts: 1 }; let status;
  const worker = workers.buildLoyaltyCampaignWorker({ repository: { claim: async () => { const value = job; job = null; return value; }, prepare: async () => true, complete: async (_, value) => { status = value; } }, wallet: { synchronizeMember: async () => {} } });
  await worker.run(); assert.equal(status, 'processed');
});
test('SQL campaign preparation checks current consent version, device registration and ordered BIGINT campaign identity', async () => {
  let member = { marketing_consent: 1, marketing_consent_version: 2, messageCampaignId: '9007199254740994' };
  let recipient = { consent_version: 2, message: 'Offre' }; let registered = true; const updates = [];
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    query: async (sql, params) => {
      if (/SELECT id FROM shop/.test(sql)) return [[{ id: 7 }]];
      if (/SELECT marketing_consent/.test(sql)) return [[member]];
      if (/SELECT r.consent_version/.test(sql)) return [recipient ? [recipient] : []];
      if (/SELECT p.serial/.test(sql)) return [registered ? [{ serial: 'pass' }] : []];
      updates.push({ sql, params }); return [{ affectedRows: 1 }];
    } };
  const repo = workers.buildSqlCampaignJobs({ pool: { getConnection: async () => connection } });
  const job = { shopId: 7, memberId: 'member', campaignId: '9007199254740993', lease: 'lease' };
  assert.equal(await repo.prepare(job), false); assert.equal(updates.length, 0);
  job.campaignId = '9007199254740995'; member.marketing_consent = 0;
  assert.equal(await repo.prepare(job), false);
  member.marketing_consent = 1; member.marketing_consent_version = 3;
  assert.equal(await repo.prepare(job), false);
  member.marketing_consent_version = 2; registered = false;
  assert.equal(await repo.prepare(job), false);
  registered = true; recipient = null;
  assert.equal(await repo.prepare(job), false);
  recipient = { consent_version: 2, message: 'Offre' };
  assert.equal(await repo.prepare(job), true);
  assert.deepEqual(updates[0].params, ['9007199254740995', 'Offre', 7, 'member']);
  assert.doesNotMatch(updates[0].sql, /balance\s*=/);
});
