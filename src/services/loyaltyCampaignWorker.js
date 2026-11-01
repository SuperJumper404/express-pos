const { randomBytes } = require('crypto');
const { createTransactionRunner } = require('../helpers/withTransaction');
const buildSqlCampaignJobs = ({ pool = require('../config/dbPool') } = {}) => {
  const transaction = createTransactionRunner(pool);
  const identify = job => [job.campaignId, job.memberId, job.lease];
  return {
    claim: () => transaction(async connection => {
      const [[row]] = await connection.query(`SELECT CAST(campaign_id AS CHAR) AS campaignId,shopid AS shopId,member_id AS memberId,attempts FROM loyalty_wallet_campaign_recipients
        WHERE (status='pending' AND next_attempt_at<=UTC_TIMESTAMP(3)) OR (status='processing' AND locked_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE))
        ORDER BY campaign_id,member_id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!row) return null;
      row.lease = randomBytes(16).toString('hex');
      await connection.query("UPDATE loyalty_wallet_campaign_recipients SET status='processing',locked_at=UTC_TIMESTAMP(3),lease_token=? WHERE campaign_id=? AND member_id=?", [row.lease, row.campaignId, row.memberId]);
      return row;
    }),
    prepare: job => transaction(async connection => {
      await connection.query('SELECT id FROM shop WHERE id=? FOR UPDATE', [job.shopId]);
      const [[member]] = await connection.query('SELECT marketing_consent,marketing_consent_version,CAST(wallet_message_campaign_id AS CHAR) AS messageCampaignId FROM loyalty_members WHERE shopid=? AND id=? FOR UPDATE', [job.shopId, job.memberId]);
      const [[recipient]] = await connection.query(`SELECT r.consent_version,c.message FROM loyalty_wallet_campaign_recipients r JOIN loyalty_wallet_campaigns c ON c.id=r.campaign_id AND c.shopid=r.shopid
        WHERE r.campaign_id=? AND r.member_id=? AND r.lease_token=? AND r.status='processing' FOR UPDATE`, identify(job));
      if (!member || !recipient || !Number(member.marketing_consent) || Number(member.marketing_consent_version) !== Number(recipient.consent_version)
        || BigInt(member.messageCampaignId || '0') > BigInt(job.campaignId)) return false;
      const [[active]] = await connection.query(`SELECT p.serial FROM loyalty_wallet_passes p JOIN loyalty_wallet_registrations r ON r.serial=p.serial
        WHERE p.shopid=? AND p.member_id=? AND p.provider='apple' LIMIT 1`, [job.shopId, job.memberId]);
      if (!active) return false;
      if (BigInt(member.messageCampaignId || '0') < BigInt(job.campaignId)) await connection.query('UPDATE loyalty_members SET wallet_message_campaign_id=?,wallet_message=?,revision=revision+1 WHERE shopid=? AND id=?', [job.campaignId, recipient.message, job.shopId, job.memberId]);
      return true;
    }),
    complete: (job, status) => transaction(async connection => {
      await connection.query("UPDATE loyalty_wallet_campaign_recipients SET status=?,last_error=NULL,locked_at=NULL,lease_token=NULL WHERE campaign_id=? AND member_id=? AND lease_token=? AND status='processing'", [status, ...identify(job)]);
      await connection.query(`UPDATE loyalty_wallet_campaigns c SET status='processed' WHERE id=? AND status='queued'
        AND NOT EXISTS(SELECT 1 FROM loyalty_wallet_campaign_recipients r WHERE r.campaign_id=c.id AND r.status IN ('pending','processing'))`, [job.campaignId]);
    }),
    retry: (job, delay) => pool.query(`UPDATE loyalty_wallet_campaign_recipients SET status='pending',attempts=attempts+1,last_error='WALLET_SYNC_FAILED',next_attempt_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND),locked_at=NULL,lease_token=NULL
      WHERE campaign_id=? AND member_id=? AND lease_token=? AND status='processing'`, [delay, ...identify(job)]),
  };
};
const buildLoyaltyCampaignWorker = ({ repository, wallet = require('./loyaltyWallet').buildLoyaltyWallet() } = {}) => {
  let running = false;
  return { async run({ limit = 20 } = {}) {
    if (running) return 0;
    running = true; let processed = 0;
    try {
      repository = repository || buildSqlCampaignJobs();
      while (processed < Math.min(100, Math.max(1, limit))) {
        const job = await repository.claim(); if (!job) break;
        try {
          if (!await repository.prepare(job)) await repository.complete(job, 'skipped');
          else { await wallet.synchronizeMember({ shopId: job.shopId, memberId: job.memberId, provider: 'apple' }); await repository.complete(job, 'processed'); }
        } catch (_) { await repository.retry(job, Math.min(86400, 30 * 2 ** Math.min(Number(job.attempts), 12))); }
        processed++;
      }
      return processed;
    } finally { running = false; }
  } };
};
let worker;
const runLoyaltyCampaignMaintenance = () => (worker || (worker = buildLoyaltyCampaignWorker())).run();
module.exports = { buildLoyaltyCampaignWorker, buildSqlCampaignJobs, runLoyaltyCampaignMaintenance };
