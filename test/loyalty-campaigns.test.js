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

test('a campaign freezes its title with the message and a changed title cannot reuse its request id', async () => {
  const f = fixture(); const input = { shopId: 7, actorId: 2, requestId, title: 'Nouvelle offre', message: 'Un dessert offert.', target: { type: 'all' } };
  const draft = await f.service.createDraft(input);
  assert.equal(draft.message, 'Nouvelle offre\nUn dessert offert.');
  assert.equal((await f.service.createDraft(input)).id, draft.id);
  await assert.rejects(f.service.createDraft({ ...input, title: 'Autre offre' }), { code: 'LOYALTY_CAMPAIGN_CONFLICT' });
  assert.equal(f.rows.length, 1); assert.equal(f.queued(), 0);
});

test('campaign titles are single-line and title plus body obeys the existing 200-character limit', async () => {
  const input = { shopId: 7, actorId: 2, requestId, title: 'Offre', message: 'Du jour', target: { type: 'all' } };
  for (const title of [null, 7, 'x'.repeat(81), 'A\nB', 'A\rB', 'A\tB', 'A\0B']) {
    const f = fixture(); await assert.rejects(f.service.createDraft({ ...input, title }), { code: 'LOYALTY_INVALID' }); assert.equal(f.rows.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.service.createDraft({ ...input, title: 'x'.repeat(80), message: 'y'.repeat(120) }), { code: 'LOYALTY_INVALID' });
  assert.equal(f.rows.length, 0);
  assert.equal((await f.service.createDraft({ ...input, title: 'x'.repeat(80), message: 'y'.repeat(119) })).message.length, 200);
  const legacy = fixture(); assert.equal((await legacy.service.createDraft({ ...input, title: undefined, message: 'z'.repeat(200) })).message.length, 200);
});

test('campaign controller accepts the title while retaining administrator and body field checks', async () => {
  const { buildLoyaltyCampaignsController } = require('../src/controllers/c_loyaltyCampaigns'); const calls = [];
  const controller = buildLoyaltyCampaignsController({ campaigns: { createDraft: input => { calls.push(input); return { message: input.title + '\n' + input.message }; } } });
  const req = { sessionSubject: 'staff', id: 2, shopid: 7, currentUser: { id: 2, shopid: 7, status: 1, access: 0 }, query: {},
    body: { requestId, title: 'Offre', message: 'Du jour', target: { type: 'all' } } };
  const res = () => ({ set() {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
  let response = res(); await controller.create(req, response); assert.equal(response.statusCode, 200); assert.equal(calls[0].title, 'Offre');
  response = res(); await controller.create({ ...req, currentUser: { ...req.currentUser, access: 1 } }, response); assert.equal(response.statusCode, 403);
  response = res(); await controller.create({ ...req, body: { ...req.body, shopId: 8 } }, response); assert.equal(response.statusCode, 422); assert.equal(calls.length, 1);
});
