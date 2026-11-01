-- migrate:up
ALTER TABLE loyalty_members
  ADD COLUMN marketing_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN marketing_consent_at datetime(3) DEFAULT NULL,
  ADD COLUMN marketing_consent_version int unsigned NOT NULL DEFAULT 0;

-- migrate:down
ALTER TABLE loyalty_members DROP COLUMN marketing_consent_version, DROP COLUMN marketing_consent_at, DROP COLUMN marketing_consent;
