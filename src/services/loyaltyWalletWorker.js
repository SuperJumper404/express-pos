const crypto = require("crypto");

const buildSqlWalletJobsRepository = ({ pool = require("../config/dbPool") } = {}) => ({
  async claim() {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[job]] = await connection.query(`SELECT CAST(id AS CHAR) AS id,shopid,member_id,attempts FROM loyalty_wallet_jobs
        WHERE (status='pending' AND next_attempt_at<=UTC_TIMESTAMP())
          OR (status='processing' AND locked_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 15 MINUTE))
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (job) {
        // The unique lease prevents a stale worker from acknowledging a newly claimed job.
        job.lease = crypto.randomBytes(16).toString("hex");
        await connection.query("UPDATE loyalty_wallet_jobs SET status='processing',locked_at=UTC_TIMESTAMP(),lease_token=? WHERE id=?", [job.lease, job.id]);
      }
      await connection.commit(); return job;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  },
  complete: (id, lease) => pool.query("UPDATE loyalty_wallet_jobs SET status='done',last_error=NULL,locked_at=NULL,lease_token=NULL WHERE id=? AND status='processing' AND lease_token=?", [id, lease]),
  retry: (id, attempts, delay, code, lease) => pool.query(`UPDATE loyalty_wallet_jobs SET status='pending',attempts=?,last_error=?,
    next_attempt_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND),locked_at=NULL,lease_token=NULL WHERE id=? AND status='processing' AND lease_token=?`, [attempts, code, delay, id, lease]),
});

const buildLoyaltyWalletWorker = ({ repository, wallet = require("./loyaltyWallet").buildLoyaltyWallet() } = {}) => {
  let running = false;
  const repo = () => repository || (repository = buildSqlWalletJobsRepository());
  const run = async ({ limit = 20 } = {}) => {
    if (running) return 0;
    running = true; let processed = 0;
    try {
      while (processed < Math.min(Math.max(limit, 1), 100)) {
        const job = await repo().claim(); if (!job) break;
        try {
          await wallet.synchronizeMember({ shopId: job.shopid, memberId: job.member_id });
          await repo().complete(job.id, job.lease);
        } catch (_) {
          const attempts = Number(job.attempts) + 1;
          await repo().retry(job.id, attempts, Math.min(86400, 30 * 2 ** Math.min(attempts - 1, 12)), "WALLET_SYNC_FAILED", job.lease);
        }
        processed++;
      }
      return processed;
    } finally { running = false; }
  };
  return { run };
};

let worker;
const runLoyaltyWalletMaintenance = () => (worker || (worker = buildLoyaltyWalletWorker())).run();
module.exports = { buildLoyaltyWalletWorker, buildSqlWalletJobsRepository, runLoyaltyWalletMaintenance };
