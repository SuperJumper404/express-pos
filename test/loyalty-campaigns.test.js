const assert = require('node:assert/strict');
const { test } = require('node:test');
let campaigns = {};
try { campaigns = require('../src/modules/m_loyaltyCampaigns'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const requestId = '00000000-0000-4000-8000-000000000001';
const ready = { mode: 'development', applePassTypeId: 'pass.test', appleTeamId: 'TEST', appleCertificatePath: 'cert', appleKeyPath: 'key', appleWwdrPath: 'wwdr', appleAssetsPath: 'assets', appleWebServiceUrl: 'https://test.example/wallet' };
test('SQL campaign draft retains an unsigned bigint id without JavaScript rounding', async () => {
  const exactId = '9007199254740993'; const recipientIds = [];
  const connection = { async query(sql, values) {
    if (sql.startsWith('INSERT INTO loyalty_wallet_campaigns ')) return [{ insertId: Number(exactId) }];
    if (sql.startsWith('SELECT ')) return [[{ id: exactId }]];
    recipientIds.push(values[0]); return [{}];
  } };
  const repository = campaigns.buildSqlCampaignRepository({ pool: {} });
  const result = await repository.insertDraft({ shopId: 7, requestId, message: 'Offre', targetMemberId: null, actorId: 2,
    recipients: [{ id: 'member', consentVersion: 1 }], connection });
  assert.equal(result.id, exactId); assert.deepEqual(recipientIds, [exactId]);
});
function fixture() {
  assert.equal(typeof campaigns.buildLoyaltyCampaigns, 'function');
  const rows = []; let audience = [{ id: 'member-1', consentVersion: 1 }]; let queueCount = 0; let now = new Date('2026-11-01T12:00:00Z');
  const repository = {
    lockShop: async () => {}, findRequest: async ({ shopId, requestId }) => rows.find(r => r.shopId === shopId && r.requestId === requestId),
    eligible: async () => [...audience],
    insertDraft: async input => { const row = { ...input, id: String(rows.length + 1), status: 'draft', recipientCount: input.recipients.length }; rows.push(row); return row; },
    findCampaign: async ({ shopId, campaignId }) => rows.find(r => r.shopId === shopId && r.id === campaignId),
    lastSent: async ({ shopId }) => rows.filter(r => r.shopId === shopId && r.sentAt).at(-1)?.sentAt,
    queue: async ({ campaignId, now }) => { queueCount++; Object.assign(rows.find(r => r.id === campaignId), { status: 'queued', sentAt: now }); },
  };
  return { repository, service: campaigns.buildLoyaltyCampaigns({ repository, runInTransaction: work => work({}), getConfig: () => ready, clock: () => now }), rows,
    setAudience: value => { audience = value; }, setTime: value => { now = value; }, queued: () => queueCount };
}
test('campaign preview freezes recipients and repeat confirmation queues them only once', async () => {
  const f = fixture(); const input = { shopId: 7, actorId: 2, requestId, message: 'Votre offre du jour est disponible.', target: { type: 'all' } };
  const draft = await f.service.createDraft(input); assert.equal(draft.recipientCount, 1); assert.equal(draft.status, 'draft');
  f.setAudience([{ id: 'new-member', consentVersion: 1 }, { id: 'another', consentVersion: 1 }]);
  assert.equal((await f.service.createDraft(input)).recipientCount, 1);
  await assert.rejects(f.service.createDraft({ ...input, message: 'Autre message' }), { status: 409 });
  await assert.rejects(f.service.send({ shopId: 7, campaignId: draft.id, confirmed: false }));
  assert.equal(f.queued(), 0);
  await f.service.send({ shopId: 7, campaignId: draft.id, confirmed: true });
  await f.service.send({ shopId: 7, campaignId: draft.id, confirmed: true });
  assert.equal(f.queued(), 1); assert.equal(f.rows[0].recipients[0].id, 'member-1');
  await assert.rejects(f.service.send({ shopId: 8, campaignId: draft.id, confirmed: true }), { status: 404 });
});
test('campaigns reject invalid content, no recipients and sends within the restaurant cooldown', async () => {
  const f = fixture(); const input = { shopId: 7, actorId: 2, requestId, message: 'Offre du restaurant', target: { type: 'all' } };
  await assert.rejects(f.service.createDraft({ ...input, message: 'x'.repeat(201) }));
  const first = await f.service.createDraft(input); await f.service.send({ shopId: 7, campaignId: first.id, confirmed: true });
  const second = await f.service.createDraft({ ...input, requestId: '00000000-0000-4000-8000-000000000002' });
  await assert.rejects(f.service.send({ shopId: 7, campaignId: second.id, confirmed: true }), { status: 429, code: 'LOYALTY_CAMPAIGN_RATE_LIMITED' });
  f.setTime(new Date('2026-11-01T12:05:00Z')); await f.service.send({ shopId: 7, campaignId: second.id, confirmed: true });
  assert.equal(f.queued(), 2);
});
test('disabled Apple configuration and an empty eligible audience never announce a queued campaign', async () => {
  const f = fixture(); const draft = await f.service.createDraft({ shopId: 7, actorId: 2, requestId, message: 'Offre', target: { type: 'all' } });
  const disabled = campaigns.buildLoyaltyCampaigns({ repository: f.repository, runInTransaction: work => work({}), getConfig: () => ({ mode: 'disabled' }) });
  await assert.rejects(disabled.send({ shopId: 7, campaignId: draft.id, confirmed: true }), { status: 503 });
  assert.equal(f.queued(), 0);
  const empty = fixture(); empty.setAudience([]);
  const preview = await empty.service.createDraft({ shopId: 7, actorId: 2, requestId, message: 'Offre', target: { type: 'all' } });
  assert.equal(preview.recipientCount, 0);
  await assert.rejects(empty.service.send({ shopId: 7, campaignId: preview.id, confirmed: true }), { code: 'LOYALTY_CAMPAIGN_EMPTY' });
});
