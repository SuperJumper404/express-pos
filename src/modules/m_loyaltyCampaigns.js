const DomainError = require('../helpers/domainError');
const { invalid, integer } = require('../helpers/loyalty');
const { withTransaction } = require('../helpers/withTransaction');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const columns = `CAST(id AS CHAR) AS id,shopid AS shopId,request_id AS requestId,message,target_member_id AS targetMemberId,status,
  recipient_count AS recipientCount,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%sZ') AS createdAt,DATE_FORMAT(sent_at,'%Y-%m-%dT%H:%i:%sZ') AS sentAt`;
const buildSqlCampaignRepository = ({ pool = require('../config/dbPool') } = {}) => {
  const find = async (connection, where, values) => { const [[row]] = await connection.query(`SELECT ${columns} FROM loyalty_wallet_campaigns WHERE ${where} FOR UPDATE`, values); return row; };
  return {
    async lockShop({ shopId, connection }) { const [[row]] = await connection.query('SELECT id FROM shop WHERE id=? FOR UPDATE', [shopId]); if (!row) throw new DomainError(404, 'LOYALTY_NOT_FOUND', 'Restaurant not found'); },
    findRequest: ({ shopId, requestId, connection }) => find(connection, 'shopid=? AND request_id=?', [shopId, requestId]),
    findCampaign: ({ shopId, campaignId, connection }) => find(connection, 'shopid=? AND id=?', [shopId, campaignId]),
    async eligible({ shopId, targetMemberId, connection }) {
      const [rows] = await connection.query(`SELECT m.id,m.marketing_consent_version AS consentVersion FROM loyalty_members m WHERE m.shopid=? AND m.marketing_consent=1
        ${targetMemberId ? 'AND m.id=?' : ''} AND EXISTS(SELECT 1 FROM loyalty_wallet_passes p JOIN loyalty_wallet_registrations r ON r.serial=p.serial
          WHERE p.shopid=m.shopid AND p.member_id=m.id AND p.provider='apple') ORDER BY m.id`, targetMemberId ? [shopId, targetMemberId] : [shopId]);
      return rows;
    },
    async insertDraft({ shopId, requestId, message, targetMemberId, actorId, recipients, connection }) {
      await connection.query('INSERT INTO loyalty_wallet_campaigns (shopid,request_id,message,target_member_id,actor_id,recipient_count) VALUES (?,?,?,?,?,?)',
        [shopId, requestId, message, targetMemberId, actorId, recipients.length]);
      const draft = await find(connection, 'shopid=? AND request_id=?', [shopId, requestId]);
      const campaignId = draft.id;
      for (const member of recipients) await connection.query('INSERT INTO loyalty_wallet_campaign_recipients (campaign_id,shopid,member_id,consent_version) VALUES (?,?,?,?)', [campaignId, shopId, member.id, member.consentVersion]);
      return draft;
    },
    async lastSent({ shopId, connection }) { const [[row]] = await connection.query("SELECT DATE_FORMAT(MAX(sent_at),'%Y-%m-%dT%H:%i:%sZ') AS sentAt FROM loyalty_wallet_campaigns WHERE shopid=?", [shopId]); return row.sentAt; },
    async queue({ shopId, campaignId, now, connection }) {
      await connection.query("UPDATE loyalty_wallet_campaigns SET status='queued',sent_at=? WHERE shopid=? AND id=? AND status='draft'", [now, shopId, campaignId]);
      await connection.query("UPDATE loyalty_wallet_campaign_recipients SET status='pending',next_attempt_at=UTC_TIMESTAMP(3) WHERE shopid=? AND campaign_id=? AND status='draft'", [shopId, campaignId]);
    },
    async list({ shopId, page, pageSize }) {
      const [[count]] = await pool.query('SELECT COUNT(*) AS total FROM loyalty_wallet_campaigns WHERE shopid=?', [shopId]);
      const [items] = await pool.query(`SELECT ${columns},
        (SELECT COUNT(*) FROM loyalty_wallet_campaign_recipients r WHERE r.campaign_id=c.id AND r.status='processed') AS processed,
        (SELECT COUNT(*) FROM loyalty_wallet_campaign_recipients r WHERE r.campaign_id=c.id AND r.status='skipped') AS skipped,
        (SELECT COUNT(*) FROM loyalty_wallet_campaign_recipients r WHERE r.campaign_id=c.id AND r.status='pending' AND r.attempts>0) AS retrying
        FROM loyalty_wallet_campaigns c WHERE shopid=? ORDER BY id DESC LIMIT ? OFFSET ?`, [shopId, pageSize, (page - 1) * pageSize]);
      return { items, total: Number(count.total), page, pageSize };
    },
  };
};
const buildLoyaltyCampaigns = ({ repository = buildSqlCampaignRepository(), runInTransaction = withTransaction,
  getConfig = require('../services/loyaltyWallet').readConfig, clock = () => new Date() } = {}) => {
  const transaction = (shopId, work) => { integer(shopId, 1, 2147483647); return runInTransaction(async connection => { await repository.lockShop({ shopId, connection }); return work(connection); }); };
  return {
    createDraft({ shopId, actorId, requestId, title = '', message, target }) {
      integer(actorId, 1, 2147483647);
      if (!uuid(requestId) || typeof title !== 'string' || title.trim().length > 80 || /[\x00-\x1f\x7f]/.test(title)
        || typeof message !== 'string' || !message.trim() || message.trim().length > 200 || /[\x00-\x08\x0b-\x1f\x7f]/.test(message)
        || !target || !['all', 'member'].includes(target.type) || Object.keys(target).some(key => !['type', 'memberId'].includes(key))
        || (target.type === 'member' ? !uuid(target.memberId) : target.memberId !== undefined)) return Promise.reject(invalid());
      message = title.trim() ? `${title.trim()}\n${message.trim()}` : message.trim();
      if (message.length > 200) return Promise.reject(invalid());
      const targetMemberId = target.type === 'member' ? target.memberId : null;
      return transaction(shopId, async connection => {
        const existing = await repository.findRequest({ shopId, requestId, connection });
        if (existing) {
          if (existing.message !== message || existing.targetMemberId !== targetMemberId) throw new DomainError(409, 'LOYALTY_CAMPAIGN_CONFLICT', 'Campaign request already used');
          return existing;
        }
        const recipients = await repository.eligible({ shopId, targetMemberId, connection });
        return repository.insertDraft({ shopId, actorId, requestId, message, targetMemberId, recipients, connection });
      });
    },
    send({ shopId, campaignId, confirmed }) {
      if (confirmed !== true || typeof campaignId !== 'string' || !/^[1-9]\d{0,19}$/.test(campaignId) || BigInt(campaignId) > 18446744073709551615n) return Promise.reject(invalid());
      return transaction(shopId, async connection => {
        const campaign = await repository.findCampaign({ shopId, campaignId, connection });
        if (!campaign) throw new DomainError(404, 'LOYALTY_NOT_FOUND', 'Campaign not found');
        if (campaign.status !== 'draft') return campaign;
        const config = getConfig();
        if (!['development', 'production'].includes(config.mode) || ['applePassTypeId', 'appleTeamId', 'appleCertificatePath', 'appleKeyPath', 'appleWwdrPath', 'appleAssetsPath', 'appleWebServiceUrl'].some(key => !config[key])) {
          throw new DomainError(503, 'LOYALTY_WALLET_NOT_CONFIGURED', 'Configure Apple Wallet before sending updates');
        }
        if (!Number(campaign.recipientCount)) throw new DomainError(422, 'LOYALTY_CAMPAIGN_EMPTY', 'No eligible Apple Wallet cards');
        const now = clock(); const last = await repository.lastSent({ shopId, connection });
        if (last && now.getTime() - new Date(last).getTime() < 300000) throw new DomainError(429, 'LOYALTY_CAMPAIGN_RATE_LIMITED', 'Wait five minutes between campaigns',
          { retryAfterSeconds: Math.ceil((300000 - (now.getTime() - new Date(last).getTime())) / 1000) });
        await repository.queue({ shopId, campaignId, now, connection });
        return { ...campaign, status: 'queued', sentAt: now.toISOString() };
      });
    },
    list({ shopId, page = 1, pageSize = 25 }) { integer(shopId, 1, 2147483647); integer(page, 1, 1000000); integer(pageSize, 1, 100); return repository.list({ shopId, page, pageSize }); },
  };
};
module.exports = { buildLoyaltyCampaigns, buildSqlCampaignRepository };
