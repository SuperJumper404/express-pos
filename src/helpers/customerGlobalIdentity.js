const { randomUUID } = require('crypto');
const DomainError = require('./domainError');

const identityChannel = channel => ['sms', 'whatsapp'].includes(channel) ? 'phone' : channel;
// Called only after OTP verification, inside the existing serialized auth transaction.
// Unverified staff contact fields and historical orders never participate in linking.
const findVerifiedCustomerAccount = async ({ connection, channel, destination, shopId }) => {
  const [[identity]] = await connection.query('SELECT account_id FROM customer_account_identities WHERE channel=? AND destination=? FOR UPDATE', [identityChannel(channel), destination]);
  if (!identity) return null;
  const [[customer]] = await connection.query('SELECT CAST(id AS CHAR) AS id FROM customers WHERE shopid=? AND global_customer_id=? FOR UPDATE', [shopId, identity.account_id]);
  return customer ? customer.id : null;
};
const linkVerifiedCustomerIdentity = async ({ connection, shopId, customerId, channel, destination }) => {
  const [[customer]] = await connection.query('SELECT global_customer_id FROM customers WHERE shopid=? AND id=? FOR UPDATE', [shopId, customerId]);
  if (!customer) throw new DomainError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
  const [[identity]] = await connection.query('SELECT account_id FROM customer_account_identities WHERE channel=? AND destination=? FOR UPDATE', [identityChannel(channel), destination]);
  if (customer.global_customer_id && identity && identity.account_id !== customer.global_customer_id) {
    throw new DomainError(409, 'CUSTOMER_IDENTITY_CONFLICT', 'Contact belongs to another account; explicit recovery required');
  }
  const accountId = customer.global_customer_id || (identity && identity.account_id) || randomUUID();
  if (!customer.global_customer_id && !identity) await connection.query('INSERT INTO customer_accounts (id) VALUES (?)', [accountId]);
  if (!identity) await connection.query('INSERT INTO customer_account_identities (channel,destination,account_id,verified_at) VALUES (?,?,?,UTC_TIMESTAMP())', [identityChannel(channel), destination, accountId]);
  if (!customer.global_customer_id) await connection.query('UPDATE customers SET global_customer_id=? WHERE shopid=? AND id=?', [accountId, shopId, customerId]);
  return accountId;
};
module.exports = { findVerifiedCustomerAccount, linkVerifiedCustomerIdentity };
