const DomainError = require('../helpers/domainError');
const { buildClientDirectory, selectClientRows, clientDirectoryCsv } = require('../helpers/clientDirectory');
const invalid = () => new DomainError(400, 'CLIENT_DIRECTORY_INVALID', 'Vérifiez les paramètres clients.');
const missing = () => new DomainError(404, 'CLIENT_NOT_FOUND', 'Client introuvable dans ce restaurant.');
const protectedContact = () => new DomainError(409, 'CLIENT_CONTACT_PROTECTED', 'Cette fiche possède déjà un compte, une carte, des commandes liées ou des adresses.');
const validId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const validKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const rowView = ({ orders, ...row }) => row;

const buildSqlClientDirectoryRepository = ({ pool = require('../config/dbPool') } = {}) => ({
  async loadSources({ shopId, connection = pool }) {
    const [customers] = await connection.query(`SELECT CAST(c.id AS CHAR) AS id,c.shopid,c.name,c.contact_phone,c.contact_email,
      EXISTS(SELECT 1 FROM customer_addresses a WHERE a.shopid=c.shopid AND a.customer_id=c.id) AS has_addresses,
      EXISTS(SELECT 1 FROM orders o WHERE o.shopid=c.shopid AND (o.customer_account_id=c.id OR o.customer_profile_id=c.id))
        OR EXISTS(SELECT 1 FROM archives a WHERE a.shopid=c.shopid AND (a.customer_account_id=c.id OR a.customer_profile_id=c.id)) AS has_linked_orders
      FROM customers c WHERE c.shopid=?`, [shopId]);
    const [identities] = await connection.query(`SELECT shopid,CAST(customer_id AS CHAR) AS customer_id,channel,destination,verified_at
      FROM customer_identities WHERE shopid=? AND verified_at IS NOT NULL`, [shopId]);
    const [members] = await connection.query(`SELECT id,shopid,CAST(customer_id AS CHAR) AS customer_id,card_number,balance,reserved
      FROM loyalty_members WHERE shopid=?`, [shopId]);
    const [archives] = await connection.query(`SELECT id,shopid,ordernumber,customer,phone,subtotal,created,CAST(customer_account_id AS CHAR) AS customer_account_id,CAST(customer_profile_id AS CHAR) AS customer_profile_id
      FROM archives WHERE shopid=? AND COALESCE(hidden_from_history,0)=0`, [shopId]);
    let links = [], linksReady = true;
    try {
      [links] = await connection.query(`SELECT shopid,contact_key,CAST(customer_id AS CHAR) AS customer_id,
        CAST(source_customer_id AS CHAR) AS source_customer_id,match_kind FROM customer_directory_contacts WHERE shopid=?`, [shopId]);
    } catch (error) {
      if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
      linksReady = false;
    }
    return { customers, identities, members, archives, links, linksReady };
  },
  async lockShop({ shopId, connection }) {
    const [[shop]] = await connection.query('SELECT id FROM shop WHERE id=? FOR UPDATE', [shopId]);
    if (!shop) throw missing();
  },
  async createContact({ shopId, name, phone, connection }) {
    await connection.query('INSERT INTO customers (shopid,name,contact_phone) VALUES (?,?,?)', [shopId, name.slice(0, 255), phone.slice(0, 255)]);
    const [[row]] = await connection.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
    return row.id;
  },
  async saveLink({ shopId, contactKey, customerId, sourceCustomerId, matchKind, actorId, connection }) {
    const [[previous]] = await connection.query('SELECT CAST(customer_id AS CHAR) AS customer_id FROM customer_directory_contacts WHERE shopid=? AND contact_key=? FOR UPDATE', [shopId, contactKey]);
    await connection.query(`INSERT INTO customer_directory_contacts (shopid,contact_key,customer_id,source_customer_id,match_kind)
      VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE customer_id=VALUES(customer_id),source_customer_id=VALUES(source_customer_id),match_kind=VALUES(match_kind),updated_at=UTC_TIMESTAMP()`,
      [shopId, contactKey, customerId, sourceCustomerId, matchKind]);
    await connection.query(`INSERT INTO customer_directory_events (shopid,contact_key,from_customer_id,to_customer_id,match_kind,actor_id)
      VALUES (?,?,?,?,?,?)`, [shopId, contactKey, previous?.customer_id || null, customerId, matchKind, actorId || null]);
  },
});

const buildClientDirectoryService = ({ repository = buildSqlClientDirectoryRepository(),
  runInTransaction = require('../helpers/withTransaction').withTransaction, clock = () => new Date() } = {}) => {
  const validateShop = shopId => { if (!Number.isInteger(shopId) || shopId < 1 || shopId > 2147483647) throw invalid(); };
  const snapshot = async (scope, connection) => {
    validateShop(scope.shopId);
    const sources = await repository.loadSources({ shopId: scope.shopId, connection });
    return { ...buildClientDirectory({ ...sources, ...scope, now: clock() }), sources };
  };
  const options = scope => {
    const page = Number(scope.page ?? 1), pageSize = Number(scope.pageSize ?? 25);
    const q = scope.q ?? '', filter = scope.filter ?? 'all', sortBy = scope.sortBy || 'lastOrderAt';
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
      || typeof q !== 'string' || q.length > 200 || /[\x00-\x1f]/.test(q)
      || !['all', 'members', 'nonmembers', 'unmatched', 'inactive'].includes(filter)
      || !['lastOrderAt', 'name', 'orderCount', 'totalSpent', 'averageSpent', 'firstOrderAt'].includes(sortBy)
      || (scope.sortDesc !== undefined && ![true, false, 'true', 'false'].includes(scope.sortDesc))) throw invalid();
    if (!scope.canManageLoyalty && ['members', 'nonmembers'].includes(filter)) throw new DomainError(403, 'CLIENT_DIRECTORY_FORBIDDEN', 'Accès fidélité non autorisé.');
    return { page, pageSize, q, filter, sortBy, sortDesc: scope.sortDesc == null ? true : [true, 'true'].includes(scope.sortDesc) };
  };
  const selected = (rows, query) => selectClientRows(rows, query).sort((a, b) => {
    const av = a[query.sortBy], bv = b[query.sortBy];
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av || '').localeCompare(String(bv || ''), 'fr');
    return (query.sortDesc ? -cmp : cmp) || a.id.localeCompare(b.id);
  });
  const requireSchema = sources => {
    if (sources.linksReady === false) throw new DomainError(503, 'CLIENT_DIRECTORY_MIGRATION_REQUIRED', 'Le rapprochement des contacts nécessite la mise à jour du service.');
  };
  return {
    async list(scope) {
      const query = options(scope);
      const view = await runInTransaction(connection => snapshot(scope, connection));
      const rows = selected(view.rows, query);
      return { items: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map(rowView),
        total: rows.length, page: query.page, pageSize: query.pageSize, metrics: view.metrics,
        capabilities: { manageLoyalty: Boolean(scope.canManageLoyalty), reconcile: Boolean(scope.canManageLoyalty && view.sources.linksReady !== false) },
        needsImport: view.contacts.some(contact => !contact.imported) };
    },
    async detail(scope) {
      if (!validId(scope.id) && !/^historical:[a-f0-9]{64}$/.test(String(scope.id))) throw invalid();
      const view = await runInTransaction(connection => snapshot(scope, connection));
      const key = scope.id.startsWith('historical:') ? scope.id.slice(11) : null;
      const oldContact = view.contacts.find(contact => contact.sourceCustomerId === scope.id);
      const row = view.rows.find(row => row.id === scope.id || (key && row.contactKeys.includes(key))
        || (oldContact && row.contactKeys.includes(oldContact.contactKey)));
      if (!row) throw missing();
      return { client: rowView(row), orders: row.orders,
        candidates: scope.canManageLoyalty ? view.rows.filter(candidate => row.reconciliation.candidateIds.includes(candidate.customerId)).map(rowView) : [] };
    },
    async exportCsv(scope) {
      const query = options(scope);
      const view = await runInTransaction(connection => snapshot(scope, connection));
      return clientDirectoryCsv(selected(view.rows, query));
    },
    async reconcile({ shopId, actorId = null, dryRun = true }) {
      validateShop(shopId);
      if (typeof dryRun !== 'boolean') throw invalid();
      return runInTransaction(async connection => {
        await repository.lockShop({ shopId, connection });
        const view = await snapshot({ shopId, canManageLoyalty: true }, connection);
        requireSchema(view.sources);
        const result = { dryRun, created: 0, linked: 0, ambiguous: 0, unchanged: 0 };
        for (const contact of view.contacts) {
          if (contact.status === 'ambiguous') { result.ambiguous++; continue; }
          const previous = view.sources.links.find(link => link.contact_key === contact.contactKey);
          if (previous && String(previous.customer_id) === contact.customerId && previous.match_kind === contact.matchKind) { result.unchanged++; continue; }
          let customerId = contact.customerId, sourceCustomerId = contact.sourceCustomerId;
          if (!customerId) {
            result.created++;
            if (dryRun) continue;
            customerId = await repository.createContact({ shopId, name: contact.name, phone: contact.phone, connection });
            sourceCustomerId = customerId;
          } else result.linked++;
          if (!dryRun) await repository.saveLink({ shopId, contactKey: contact.contactKey, customerId, sourceCustomerId,
            matchKind: contact.matchKind, actorId, connection });
        }
        return result;
      });
    },
    async linkContact({ shopId, actorId, contactKey, customerId }) {
      validateShop(shopId);
      if (!validKey(contactKey) || !validId(customerId)) throw invalid();
      return runInTransaction(async connection => {
        await repository.lockShop({ shopId, connection });
        const view = await snapshot({ shopId, canManageLoyalty: true }, connection);
        requireSchema(view.sources);
        const contact = view.contacts.find(value => value.contactKey === contactKey);
        const target = view.sources.customers.find(value => String(value.id) === customerId && Number(value.shopid) === shopId);
        if (!contact || !target) throw missing();
        const previous = view.sources.links.find(link => link.contact_key === contactKey);
        if (previous?.match_kind === 'manual' && String(previous.customer_id) === customerId) return { linked: true, customerId };
        if (contact.protected || contact.sourceCustomerId === customerId
          || view.sources.links.some(link => String(link.source_customer_id) === customerId)) throw protectedContact();
        await repository.saveLink({ shopId, actorId, contactKey, customerId, sourceCustomerId: contact.sourceCustomerId,
          matchKind: 'manual', connection });
        return { linked: true, customerId };
      });
    },
  };
};
module.exports = { buildClientDirectoryService, buildSqlClientDirectoryRepository };
