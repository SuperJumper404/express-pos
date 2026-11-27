const pool = require("../config/dbPool");
const { withTransaction } = require("../helpers/withTransaction");

async function beginAttempt({ shopId, staffId, stateHash }) {
  await pool.execute(
    `INSERT INTO mollie_oauth_attempts (shopid, staff_id, state_hash, expires_at)
     VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE))
     ON DUPLICATE KEY UPDATE staff_id = ?, state_hash = ?,
       expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE), state_used = 0,
       organization_id = NULL, organization_name = NULL, encrypted_tokens = NULL`,
    [shopId, staffId, stateHash, staffId, stateHash],
  );
}

function claimAttempt(stateHash) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT shopid FROM mollie_oauth_attempts
       WHERE state_hash = ? AND state_used = 0 AND expires_at > UTC_TIMESTAMP() FOR UPDATE`,
      [stateHash],
    );
    if (!rows.length) return null;
    await conn.execute("UPDATE mollie_oauth_attempts SET state_used = 1 WHERE state_hash = ?", [stateHash]);
    return rows[0].shopid;
  });
}

async function stageConnection({ shopId, stateHash, organizationId, organizationName, encryptedTokens }) {
  const [result] = await pool.execute(
    `UPDATE mollie_oauth_attempts SET organization_id = ?, organization_name = ?, encrypted_tokens = ?,
       expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE)
     WHERE shopid = ? AND state_hash = ? AND state_used = 1 AND expires_at > UTC_TIMESTAMP()`,
    [organizationId, organizationName, encryptedTokens, shopId, stateHash],
  );
  return result.affectedRows === 1;
}

async function getStatus({ shopId, staffId }) {
  const [rows] = await pool.execute(
    `SELECT c.organization_id, c.organization_name,
       a.state_hash AS pending_id, a.organization_id AS pending_org_id, a.organization_name AS pending_name
     FROM shop s LEFT JOIN mollie_connections c ON c.shopid = s.id
     LEFT JOIN mollie_oauth_attempts a ON a.shopid = s.id AND a.staff_id = ?
       AND a.expires_at > UTC_TIMESTAMP() AND a.organization_id IS NOT NULL
     WHERE s.id = ?`,
    [staffId, shopId],
  );
  const row = rows[0] || {};
  return {
    connection: row.organization_id ? { id: row.organization_id, name: row.organization_name } : null,
    pending: row.pending_id ? { id: row.pending_id, organizationId: row.pending_org_id, name: row.pending_name } : null,
  };
}

function confirmConnection({ shopId, staffId, pendingId }) {
  return withTransaction(async (conn) => {
    const [attempts] = await conn.execute(
      `SELECT organization_id, organization_name, encrypted_tokens FROM mollie_oauth_attempts
       WHERE shopid = ? AND staff_id = ? AND state_hash = ? AND encrypted_tokens IS NOT NULL
         AND expires_at > UTC_TIMESTAMP() FOR UPDATE`,
      [shopId, staffId, pendingId],
    );
    if (!attempts.length) return "expired";
    const attempted = attempts[0];
    const [current] = await conn.execute(
      "SELECT organization_id FROM mollie_connections WHERE shopid = ? FOR UPDATE", [shopId],
    );
    if (current.length && current[0].organization_id !== attempted.organization_id) {
      return "different_organization";
    }
    await conn.execute(
      `INSERT INTO mollie_connections (shopid, organization_id, organization_name, encrypted_tokens)
       VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE organization_name = ?, encrypted_tokens = ?,
       connected_at = CURRENT_TIMESTAMP`,
      [shopId, attempted.organization_id, attempted.organization_name, attempted.encrypted_tokens,
        attempted.organization_name, attempted.encrypted_tokens],
    );
    await conn.execute("DELETE FROM mollie_oauth_attempts WHERE shopid = ? AND state_hash = ?", [shopId, pendingId]);
    return "connected";
  });
}

module.exports = { beginAttempt, claimAttempt, stageConnection, getStatus, confirmConnection };
