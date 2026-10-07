-- Preserve existing audit data while migrating installation ownership to users.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE otp_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);


INSERT INTO users (id, email, created_at) SELECT id, id || '@legacy.invalid', created_at FROM installations;

CREATE TABLE migration_backup_audits AS SELECT * FROM audits;

CREATE TABLE migration_backup_documents AS SELECT * FROM documents;

CREATE TABLE migration_backup_document_facts AS SELECT * FROM document_facts;

CREATE TABLE migration_backup_vendors AS SELECT * FROM vendors;

CREATE TABLE migration_backup_payments AS SELECT * FROM payments;

CREATE TABLE migration_backup_coverage_records AS SELECT * FROM coverage_records;

CREATE TABLE migration_backup_vendor_matches AS SELECT * FROM vendor_matches;

CREATE TABLE migration_backup_findings AS SELECT * FROM findings;

CREATE TABLE migration_backup_model_decisions AS SELECT * FROM model_decisions;

DROP TABLE model_decisions;

DROP TABLE findings;

DROP TABLE vendor_matches;

DROP TABLE coverage_records;

DROP TABLE payments;

DROP TABLE vendors;

DROP TABLE document_facts;

DROP TABLE documents;

DROP TABLE audits;

CREATE TABLE audits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    name TEXT,
    policy_period_start TEXT,
    policy_period_end TEXT,
    exposure_basis TEXT,
    wc_rate_micros_per_100 INTEGER,
    assumptions_confirmed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);


CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    document_type TEXT NOT NULL,
    processing_status TEXT NOT NULL,
    markdown_object_key TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

CREATE TABLE document_facts (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    fact_type TEXT NOT NULL,
    value_json TEXT,
    source_excerpt TEXT,
    extractor TEXT,
    confidence REAL,
    confirmed_by_user INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    address TEXT,
    external_reference TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(audit_id) REFERENCES audits(id) ON DELETE CASCADE
);

CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    source_vendor_name TEXT,
    amount_cents INTEGER NOT NULL,
    payment_date TEXT,
    work_start_date TEXT,
    work_end_date TEXT,
    memo TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(audit_id) REFERENCES audits(id) ON DELETE CASCADE,
    FOREIGN KEY(vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
    FOREIGN KEY(source_document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE coverage_records (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    named_insured TEXT,
    normalized_named_insured TEXT,
    carrier TEXT,
    policy_number TEXT,
    effective_date TEXT,
    expiration_date TEXT,
    wc_section_present INTEGER DEFAULT 0,
    wc_coverage_indicated INTEGER DEFAULT 0,
    certificate_issue_date TEXT,
    extraction_confidence REAL,
    review_status TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(audit_id) REFERENCES audits(id) ON DELETE CASCADE,
    FOREIGN KEY(source_document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE vendor_matches (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    coverage_record_id TEXT NOT NULL,
    deterministic_score REAL,
    clef_probability REAL,
    status TEXT NOT NULL,
    reason_json TEXT,
    FOREIGN KEY(audit_id) REFERENCES audits(id) ON DELETE CASCADE,
    FOREIGN KEY(vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
    FOREIGN KEY(coverage_record_id) REFERENCES coverage_records(id) ON DELETE CASCADE
);

CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    amount_cents INTEGER,
    data_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(audit_id) REFERENCES audits(id) ON DELETE CASCADE,
    FOREIGN KEY(vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
);

CREATE TABLE model_decisions (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    document_id TEXT,
    question_pack TEXT NOT NULL,
    question_pack_version TEXT NOT NULL,
    model TEXT NOT NULL,
    state_sha256 TEXT NOT NULL,
    answers_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(audit_id) REFERENCES audits(id) ON DELETE CASCADE,
    FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
);

INSERT INTO audits (id, user_id, status, name, policy_period_start, policy_period_end, exposure_basis, wc_rate_micros_per_100, assumptions_confirmed_at, created_at, updated_at)
SELECT id, installation_id, status, name, policy_period_start, policy_period_end, exposure_basis, wc_rate_micros_per_100, assumptions_confirmed_at, created_at, updated_at FROM migration_backup_audits;

INSERT INTO documents SELECT * FROM migration_backup_documents;

INSERT INTO document_facts SELECT * FROM migration_backup_document_facts;

INSERT INTO vendors SELECT * FROM migration_backup_vendors;

INSERT INTO payments SELECT * FROM migration_backup_payments;

INSERT INTO coverage_records SELECT * FROM migration_backup_coverage_records;

INSERT INTO vendor_matches SELECT * FROM migration_backup_vendor_matches;

INSERT INTO findings SELECT * FROM migration_backup_findings;

INSERT INTO model_decisions SELECT * FROM migration_backup_model_decisions;

DROP TABLE migration_backup_audits;

DROP TABLE migration_backup_documents;

DROP TABLE migration_backup_document_facts;

DROP TABLE migration_backup_vendors;

DROP TABLE migration_backup_payments;

DROP TABLE migration_backup_coverage_records;

DROP TABLE migration_backup_vendor_matches;

DROP TABLE migration_backup_findings;

DROP TABLE migration_backup_model_decisions;

DROP TABLE installations;
PRAGMA defer_foreign_keys=OFF;
