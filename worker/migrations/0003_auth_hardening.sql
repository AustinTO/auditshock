ALTER TABLE otp_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
-- Invalidate older plaintext codes when deploying the hashed-code implementation.
UPDATE otp_codes SET used = 1;
CREATE UNIQUE INDEX sessions_token_hash_unique ON sessions(token_hash);
CREATE INDEX otp_email_expiry ON otp_codes(email, expires_at);
CREATE INDEX audits_user ON audits(user_id);
CREATE INDEX documents_audit ON documents(audit_id);
CREATE INDEX payments_audit ON payments(audit_id);
