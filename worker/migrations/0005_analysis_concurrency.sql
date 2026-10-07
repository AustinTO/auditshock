ALTER TABLE audits ADD COLUMN workflow_id TEXT;
ALTER TABLE audits ADD COLUMN mutation_lease_id TEXT;
ALTER TABLE audits ADD COLUMN mutation_expires_at INTEGER;
ALTER TABLE documents ADD COLUMN review_error TEXT;
-- Transient validation rows force an entire D1 batch to roll back if an edit lost its lease.
CREATE TABLE audit_mutation_checks (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK(valid = 1)
);
CREATE TABLE auth_email_limits (
  email TEXT PRIMARY KEY,
  next_request_at INTEGER NOT NULL
);
