CREATE TABLE auth_request_limits (
  bucket_key TEXT PRIMARY KEY,
  requests INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_limits_expiry ON auth_request_limits(expires_at);
