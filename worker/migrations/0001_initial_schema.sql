-- Migration number: 0001 	 2026-10-06T00:00:00.000Z

CREATE TABLE installations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT
);

CREATE TABLE audits (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    name TEXT,
    policy_period_start TEXT,
    policy_period_end TEXT,
    exposure_basis TEXT,
    wc_rate_micros_per_100 INTEGER,
    assumptions_confirmed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(installation_id) REFERENCES installations(id) ON DELETE CASCADE
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
