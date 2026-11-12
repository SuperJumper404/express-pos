const { createHash } = require('crypto');
const { normalizeCustomerDestination } = require('./customerIdentity');

const text = value => String(value == null ? '' : value).trim();
const id = value => value == null ? null : String(value);
const money = value => Math.round((Number(value) || 0) * 100) / 100;
const verifiedPhone = value => {
  try { return normalizeCustomerDestination({ channel: 'sms', value: text(value), countryCode: 'FR' }); }
  catch (_) { return null; }
};
const clientPhoneKey = value => verifiedPhone(value) || text(value).replace(/[^\d+]/g, '');
const contactKey = phone => createHash('sha256').update(phone).digest('hex');
const topNames = names => Object.entries(names).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr')).map(([name]) => name);
const emptyRow = (key, customer = {}) => ({ id: key, customerId: customer.id ? id(customer.id) : null, contactKeys: [],
  name: text(customer.name), phone: text(customer.contact_phone), email: text(customer.contact_email), aliases: [],
  source: customer.id ? 'profile' : 'historical', verified: false, orderCount: 0, totalSpent: 0, averageSpent: 0,
  firstOrderAt: null, lastOrderAt: null, lastVisitDays: null, lastVisitLabel: '-',
  reconciliation: { status: 'none', candidateIds: [], contactKeys: [], canLink: false }, orders: [], _names: {} });

function buildClientDirectory({ shopId, customers = [], identities = [], members = [], archives = [], links = [], canManageLoyalty = false, now = new Date() }) {
  const scoped = list => list.filter(row => Number(row.shopid) === Number(shopId));
  const profiles = new Map(scoped(customers).map(row => [id(row.id), row]));
  const cards = new Map(scoped(members).map(row => [id(row.customer_id), row]));
  const phoneOwners = new Map();
  const verified = new Set();
  for (const identity of scoped(identities)) {
    const owner = id(identity.customer_id);
    if (!profiles.has(owner) || !identity.verified_at) continue;
    verified.add(owner);
    if (!['sms', 'whatsapp'].includes(identity.channel)) continue;
    const phone = verifiedPhone(identity.destination);
    if (!phone) continue;
    if (!phoneOwners.has(phone)) phoneOwners.set(phone, new Set());
    phoneOwners.get(phone).add(owner);
  }
  const visibleArchives = scoped(archives).filter(row => !Number(row.hidden_from_history));
  const groups = new Map();
  const bound = [];
  for (const order of visibleArchives) {
    if (order.customer_account_id != null) { bound.push(order); continue; }
    const phoneKey = clientPhoneKey(order.phone);
    if (!phoneKey) continue;
    const key = contactKey(phoneKey);
    if (!groups.has(key)) groups.set(key, { contactKey: key, phoneKey, phone: text(order.phone), names: {}, orders: [] });
    const group = groups.get(key);
    group.orders.push(order);
    const name = text(order.customer);
    if (name) group.names[name] = (group.names[name] || 0) + 1;
  }
  const storedLinks = new Map(scoped(links).map(link => [link.contact_key, link]));
  // A persisted contact/alias outlives its last visible purchase. Do not restore
  // hidden orders, but keep the same directory identity and resolvable links.
  for (const link of storedLinks.values()) {
    if (!groups.has(link.contact_key)) groups.set(link.contact_key, {
      contactKey: link.contact_key, phoneKey: '', phone: '', names: {}, orders: [],
    });
  }
  const phoneOwnersByKey = new Map([...phoneOwners].map(([phone, owners]) => [contactKey(phone), owners]));
  const contacts = [];
  const aliases = new Map();
  const protectedProfile = key => verified.has(key) || cards.has(key) || Number((profiles.get(key) || {}).has_addresses) > 0
    || Number((profiles.get(key) || {}).has_linked_orders) > 0
    || bound.some(order => id(order.customer_account_id) === key);
  for (const group of groups.values()) {
    const link = storedLinks.get(group.contactKey);
    const source = link && id(link.source_customer_id);
    const candidates = [...(phoneOwners.get(verifiedPhone(group.phone)) || phoneOwnersByKey.get(group.contactKey) || [])].sort();
    let customerId = link && profiles.has(id(link.customer_id)) ? id(link.customer_id) : null;
    let matchKind = link && link.match_kind;
    const fixedLink = link && link.match_kind !== 'import';
    let ambiguous = candidates.length > 1 && !fixedLink;
    const protectedSource = source && protectedProfile(source);
    if (protectedSource && customerId !== source) {
      customerId = source;
      ambiguous = true;
    }
    if ((!link || link.match_kind === 'import') && candidates.length === 1) {
      if (source && protectedSource && source !== candidates[0]) ambiguous = true;
      else { customerId = candidates[0]; matchKind = 'verified_phone'; }
    }
    if (source && customerId && source !== customerId && !protectedSource) aliases.set(source, customerId);
    contacts.push({ ...group, names: topNames(group.names), name: topNames(group.names)[0] || '', customerId,
      sourceCustomerId: source, matchKind: matchKind || 'import', imported: Boolean(link),
      protected: Boolean(protectedSource || fixedLink), candidateIds: candidates,
      status: ambiguous ? 'ambiguous' : customerId && matchKind !== 'import' ? 'matched' : 'unmatched' });
  }
  const rows = new Map([...profiles].filter(([key]) => !aliases.has(key)).map(([key, profile]) => [key, emptyRow(key, profile)]));
  const rowFor = key => {
    if (!rows.has(key)) rows.set(key, emptyRow(key));
    return rows.get(key);
  };
  const addOrder = (row, order) => {
    row.orders.push({ id: id(order.id), orderNumber: text(order.ordernumber), customer: text(order.customer), phone: text(order.phone),
      total: money(order.subtotal), created: order.created });
    row.orderCount++;
    row.totalSpent = money(row.totalSpent + money(order.subtotal));
    const name = text(order.customer);
    if (name) row._names[name] = (row._names[name] || 0) + 1;
    const date = new Date(order.created);
    if (!Number.isNaN(date.getTime())) {
      const iso = date.toISOString();
      if (!row.firstOrderAt || iso < row.firstOrderAt) row.firstOrderAt = iso;
      if (!row.lastOrderAt || iso > row.lastOrderAt) row.lastOrderAt = iso;
    }
  };
  for (const order of bound) {
    const owner = id(order.customer_account_id);
    // An explicit foreign/missing owner is never reassigned by phone.
    if (profiles.has(owner)) addOrder(rowFor(aliases.get(owner) || owner), order);
  }
  for (const contact of contacts) {
    const row = rowFor(contact.customerId || `historical:${contact.contactKey}`);
    row.contactKeys.push(contact.contactKey);
    if (!row.phone) row.phone = contact.phone;
    if (contact.sourceCustomerId === row.customerId && !contact.protected) row.source = 'historical';
    if (contact.status === 'ambiguous' || contact.status === 'unmatched') row.reconciliation = {
      status: contact.status, candidateIds: [...new Set([...row.reconciliation.candidateIds, ...contact.candidateIds])],
      contactKeys: [...row.reconciliation.contactKeys, ...(!contact.protected ? [contact.contactKey] : [])],
      canLink: row.reconciliation.canLink || !contact.protected,
    };
    for (const order of contact.orders) addOrder(row, order);
  }
  for (const row of rows.values()) {
    row.aliases = topNames(row._names);
    if (!row.name) row.name = row.aliases[0] || '';
    row.verified = verified.has(row.customerId);
    if (row.verified) row.source = 'account';
    if (!row.phone && row.verified) row.phone = [...phoneOwners].find(([, owners]) => owners.has(row.customerId))?.[0] || '';
    if (!row.email && row.verified) row.email = scoped(identities).find(identity => id(identity.customer_id) === row.customerId && identity.channel === 'email' && identity.verified_at)?.destination || '';
    row.averageSpent = row.orderCount ? money(row.totalSpent / row.orderCount) : 0;
    if (row.lastOrderAt) {
      const day = value => { const date = new Date(value); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()); };
      row.lastVisitDays = Math.max(0, Math.round((day(now) - day(row.lastOrderAt)) / 86400000));
      row.lastVisitLabel = row.lastVisitDays === 0 ? "Aujourd'hui" : row.lastVisitDays === 1 ? 'Hier' : `Il y a ${row.lastVisitDays} jours`;
    }
    if (canManageLoyalty) {
      const member = cards.get(row.customerId);
      row.loyalty = member ? { id: member.id, cardNumber: member.card_number || null, balance: Number(member.balance),
        reserved: Number(member.reserved), available: Number(member.balance) - Number(member.reserved) } : null;
    }
    row.orders.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
    delete row._names;
  }
  const result = [...rows.values()].sort((a, b) => String(b.lastOrderAt || '').localeCompare(String(a.lastOrderAt || '')) || a.name.localeCompare(b.name, 'fr') || a.id.localeCompare(b.id));
  const withPhone = visibleArchives.filter(order => clientPhoneKey(order.phone)).length;
  return { rows: result, contacts, metrics: { clientCount: result.length, ordersWithPhone: withPhone,
    ordersWithoutPhone: visibleArchives.length - withPhone, inactiveOver30Days: result.filter(row => row.lastVisitDays > 30).length,
    returnRate: result.length ? Math.round(result.filter(row => row.orderCount > 1).length / result.length * 100) : 0,
    ...(canManageLoyalty ? { memberCount: result.filter(row => row.loyalty).length } : {}) } };
}

const selectClientRows = (rows, { q = '', filter = 'all' } = {}) => {
  const needle = text(q).toLocaleLowerCase('fr');
  const phoneNeedle = clientPhoneKey(q);
  return rows.filter(row => {
    if (filter === 'members' && !row.loyalty) return false;
    if (filter === 'nonmembers' && row.loyalty) return false;
    if (filter === 'unmatched' && !['ambiguous', 'unmatched'].includes(row.reconciliation.status)) return false;
    if (filter === 'inactive' && !(row.lastVisitDays > 30)) return false;
    return !needle || [row.name, row.phone, row.email, ...row.aliases, row.loyalty?.id, row.loyalty?.cardNumber]
      .some(value => text(value).toLocaleLowerCase('fr').includes(needle)) || Boolean(phoneNeedle && clientPhoneKey(row.phone).includes(phoneNeedle));
  });
};
const clientDirectoryCsv = rows => {
  const loyalty = rows.some(row => Object.hasOwn(row, 'loyalty'));
  const headers = ['Client', 'Téléphone', 'Email', 'Autres noms', 'Commandes', 'Total dépensé', 'Panier moyen', 'Première commande', 'Dernière visite',
    ...(loyalty ? ['Carte fidélité', 'Points', 'Réservés', 'Disponibles'] : [])];
  const cell = value => {
    let content = text(value);
    if (/^[=+\-@\t\r]/.test(content)) content = `'${content}`;
    return /[;"\n\r]/.test(content) ? `"${content.replace(/"/g, '""')}"` : content;
  };
  return [headers, ...rows.map(row => [row.name, row.phone, row.email, row.aliases.join(', '), row.orderCount,
    row.totalSpent.toFixed(2), row.averageSpent.toFixed(2), row.firstOrderAt || '', row.lastVisitLabel,
    ...(loyalty ? [row.loyalty?.cardNumber || row.loyalty?.id || '', row.loyalty?.balance ?? '', row.loyalty?.reserved ?? '', row.loyalty?.available ?? ''] : [])])]
    .map(line => line.map(cell).join(';')).join('\r\n');
};
module.exports = { buildClientDirectory, selectClientRows, clientDirectoryCsv, clientPhoneKey };
