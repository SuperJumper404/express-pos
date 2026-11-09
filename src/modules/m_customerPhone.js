const { createHash } = require('crypto');
const DomainError = require('../helpers/domainError');
const { normalizeCustomerDestination } = require('../helpers/customerIdentity');
const { buildClientDirectory } = require('../helpers/clientDirectory');
const invalid = () => new DomainError(422, 'CUSTOMER_PHONE_INVALID', 'Vérifiez le numéro de téléphone.');
const validShop = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const validId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const normalize = (phone, countryCode = 'FR') => {
  try { return normalizeCustomerDestination({ channel: 'sms', value: phone, countryCode }); }
  catch (_) { throw invalid(); }
};
const candidatePhone = phone => { try { return normalize(phone); } catch (_) { return null; } };
const summary = value => {
  const { customer, member } = value || {};
  return customer ? {
  customer: { id: String(customer.id), shopId: Number(customer.shopid), name: customer.name || '', phone: customer.contact_phone || '', email: customer.contact_email || '' },
  loyalty: member ? { id: member.id, cardNumber: member.card_number || null, balance: Number(member.balance), reserved: Number(member.reserved), available: Number(member.balance) - Number(member.reserved) } : null,
  } : null;
};

const buildSqlCustomerPhoneRepository = ({ pool = require('../config/dbPool') } = {}) => {
  const directory = require('./m_clientDirectory').buildSqlClientDirectoryRepository({ pool });
  return {
    lockShop: directory.lockShop,
    createContact: directory.createContact,
    saveLink: directory.saveLink,
    async loadSources({ shopId, connection }) {
      // Current locking reads matter when checkout already established a repeatable-read snapshot.
      // Always acquire the shop lock before these customer/member/binding locks.
      const [customers] = await connection.query(`SELECT CAST(c.id AS CHAR) AS id,c.shopid,c.name,c.contact_phone,c.contact_email
        FROM customers c WHERE c.shopid=? ORDER BY c.id FOR UPDATE`, [shopId]);
      // A locking outer SELECT does not make correlated EXISTS queries current reads.
      // Read protection sources explicitly after locking the customers so an earlier
      // checkout snapshot cannot hide a newly committed address or order attachment.
      const [addresses] = await connection.query(`SELECT CAST(customer_id AS CHAR) AS customer_id
        FROM customer_addresses WHERE shopid=? ORDER BY customer_id,id FOR SHARE`, [shopId]);
      const [orders] = await connection.query(`SELECT CAST(customer_account_id AS CHAR) AS customer_account_id,
        CAST(customer_profile_id AS CHAR) AS customer_profile_id FROM orders
        WHERE shopid=? AND (customer_account_id IS NOT NULL OR customer_profile_id IS NOT NULL) ORDER BY id FOR SHARE`, [shopId]);
      const [archives] = await connection.query(`SELECT CAST(customer_account_id AS CHAR) AS customer_account_id,
        CAST(customer_profile_id AS CHAR) AS customer_profile_id FROM archives
        WHERE shopid=? AND (customer_account_id IS NOT NULL OR customer_profile_id IS NOT NULL) ORDER BY id FOR SHARE`, [shopId]);
      const addressOwners = new Set(addresses.map(row => String(row.customer_id)));
      const orderOwners = new Set([...orders, ...archives].flatMap(row => [row.customer_account_id, row.customer_profile_id])
        .filter(value => value != null).map(String));
      for (const customer of customers) {
        customer.has_addresses = addressOwners.has(String(customer.id));
        customer.has_linked_orders = orderOwners.has(String(customer.id));
      }
      const [identities] = await connection.query(`SELECT shopid,CAST(customer_id AS CHAR) AS customer_id,channel,destination,verified_at
        FROM customer_identities WHERE shopid=? AND verified_at IS NOT NULL FOR UPDATE`, [shopId]);
      const [globalIdentities] = await connection.query(`SELECT c.shopid,CAST(c.id AS CHAR) AS customer_id,'sms' AS channel,i.destination,i.verified_at
        FROM customers c JOIN customer_account_identities i ON i.account_id=c.global_customer_id
        WHERE c.shopid=? AND i.channel='phone' AND i.verified_at IS NOT NULL FOR SHARE`, [shopId]);
      const [members] = await connection.query(`SELECT id,shopid,CAST(customer_id AS CHAR) AS customer_id,phone_e164,card_number,balance,reserved
        FROM loyalty_members WHERE shopid=? FOR UPDATE`, [shopId]);
      const [links] = await connection.query(`SELECT shopid,contact_key,CAST(customer_id AS CHAR) AS customer_id,
        CAST(source_customer_id AS CHAR) AS source_customer_id,match_kind FROM customer_directory_contacts WHERE shopid=? FOR UPDATE`, [shopId]);
      return { customers, identities: [...identities, ...globalIdentities], members, links, archives: [] };
    },
    async readSummary({ shopId, customerId, connection = pool, currentRead = false }) {
      const lock = currentRead ? ' FOR SHARE' : '';
      const [[customer]] = await connection.query(`SELECT CAST(id AS CHAR) AS id,shopid,name,contact_phone,contact_email FROM customers WHERE shopid=? AND id=?${lock}`, [shopId, customerId]);
      if (!customer) return null;
      const [[member]] = await connection.query(`SELECT id,card_number,balance,reserved FROM loyalty_members WHERE shopid=? AND customer_id=?${lock}`, [shopId, customerId]);
      return { customer, member };
    },
  };
};

const buildCustomerPhoneService = ({ repository = buildSqlCustomerPhoneRepository(), runInTransaction = require('../helpers/withTransaction').withTransaction } = {}) => {
  const service = {
    async resolve({ shopId, phone, countryCode = 'FR', name = '', connection } = {}) {
      const normalized = normalize(phone, countryCode);
      if (!validShop(shopId) || typeof name !== 'string' || name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) throw invalid();
      const work = async connection => {
        await repository.lockShop({ shopId, connection });
        const loaded = await repository.loadSources({ shopId, connection });
        const scoped = list => (list || []).filter(row => Number(row.shopid) === shopId);
        const sources = { customers: scoped(loaded.customers), identities: scoped(loaded.identities), members: scoped(loaded.members), links: scoped(loaded.links), archives: scoped(loaded.archives) };
        const profiles = new Map(sources.customers.map(c => [String(c.id), c]));
        const contactKey = createHash('sha256').update(normalized).digest('hex');
        const view = buildClientDirectory({ ...sources, shopId, canManageLoyalty: true });
        const projected = view.contacts.find(c => c.contactKey === contactKey);
        const previous = sources.links.find(link => link.contact_key === contactKey);
        const ambiguous = () => ({ status: 'ambiguous', phone: normalized, created: false, customer: null, loyalty: null });
        if (projected?.status === 'ambiguous') return ambiguous();
        const aliases = new Map(view.contacts.filter(c => c.sourceCustomerId && c.customerId && c.sourceCustomerId !== c.customerId && c.status !== 'ambiguous')
          .map(c => [c.sourceCustomerId, c.customerId]));
        const canonical = value => {
          let owner = String(value); const seen = new Set();
          while (aliases.has(owner) && !seen.has(owner)) { seen.add(owner); owner = aliases.get(owner); }
          return owner;
        };
        const candidates = new Set();
        const add = value => { const owner = canonical(value); if (profiles.has(owner)) candidates.add(owner); };
        if (projected?.customerId) add(projected.customerId);
        for (const c of sources.customers) if (candidatePhone(c.contact_phone) === normalized) add(c.id);
        for (const i of sources.identities) if (i.verified_at && ['sms', 'whatsapp', 'phone'].includes(i.channel) && candidatePhone(i.destination) === normalized) add(i.customer_id);
        for (const m of sources.members) if (candidatePhone(m.phone_e164) === normalized) add(m.customer_id);
        if (candidates.size > 1) return ambiguous();
        let customerId = [...candidates][0], created = false;
        if (!customerId) {
          customerId = String(await repository.createContact({ shopId, name: name.trim(), phone: normalized, connection }));
          created = true;
        }
        if (!previous || String(previous.customer_id) !== customerId) {
          await repository.saveLink({ shopId, contactKey, customerId, sourceCustomerId: previous?.source_customer_id || (created ? customerId : null),
            matchKind: previous && projected?.matchKind === 'verified_phone' ? 'verified_phone' : 'phone', actorId: null, connection });
        }
        const result = summary(await repository.readSummary({ shopId, customerId, connection, currentRead: true }));
        if (!result) throw new DomainError(503, 'CUSTOMER_PHONE_UNAVAILABLE', 'La fiche client est indisponible.');
        return { status: 'resolved', phone: normalized, created, ...result };
      };
      return connection ? work(connection) : runInTransaction(work);
    },
    async resolveForCheckout(scope) {
      try { const result = await service.resolve(scope); return result.status === 'resolved' ? result : null; }
      catch (error) { if (error instanceof DomainError && error.code === 'CUSTOMER_PHONE_INVALID') return null; throw error; }
    },
    async getSummary({ shopId, customerId, connection } = {}) {
      if (!validShop(shopId) || !validId(customerId)) return null;
      return summary(await repository.readSummary({ shopId, customerId, connection }));
    },
  };
  return service;
};
module.exports = { buildCustomerPhoneService, buildSqlCustomerPhoneRepository };
