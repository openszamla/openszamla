/**
 * Database schema of OpenSzámla as an ordered list of migrations.
 *
 * Rules for maintainers:
 * - Never edit a migration that has been released. Append a new one with the next version number.
 * - The store applies every pending migration in ONE transaction together with the
 *   `meta.schema_version` bump, so a failed migration leaves the database unchanged.
 * - Decimal values (money, quantities, rates) are TEXT holding canonical decimal strings – never REAL.
 * - Complex objects are JSON TEXT columns; columns used for filtering/sorting are plain copies.
 * - Every invoice column that is NOT listed as "mutable after issuance" must be covered by the
 *   `invoices_immutable_columns` trigger. A migration that adds a column to `invoices` must
 *   recreate that trigger (or consciously document the new column as mutable).
 * - Triggers use string literals in RAISE() (no expressions) so older SQLite versions can still
 *   parse the schema.
 * - Protected tables must also guard INSERT: "INSERT OR REPLACE" resolves a UNIQUE/PRIMARY KEY
 *   conflict by deleting the existing row, and that delete fires DELETE triggers only on
 *   connections with recursive_triggers ON (external SQLite tools have it OFF). Every UNIQUE key of
 *   a protected table therefore needs a BEFORE INSERT (and, if the key can change, BEFORE UPDATE)
 *   guard that refuses to collide with a protected row.
 *
 * Trigger error messages start with a machine-readable code ("IMMUTABLE_INVOICE: …",
 * "DUPLICATE_INVOICE_NUMBER: …", "AUDIT_APPEND_ONLY: …", "IMMUTABLE_NAV_SUBMISSION: …",
 * "IMMUTABLE_DOCUMENT: …", "IMMUTABLE_PAYMENT: …"); the store maps them to AppError codes.
 */

export interface Migration {
  /** Strictly increasing, starting at 1. Stored in meta.schema_version once applied. */
  version: number;
  /** One or more SQL statements (executed with DatabaseSync.exec). */
  sql: string;
}

const ZERO_HASH_LITERAL = `'${'0'.repeat(64)}'`;

const V1_INITIAL = /* sql */ `
-- Key/value metadata of the database itself (schema_version, created_at, …).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Arbitrary JSON settings (seller profile, NAV credentials reference, defaults, …).
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
) STRICT;

-- Partners. "data" holds the complete Customer object; the other columns are search/filter copies.
CREATE TABLE customers (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  vat_status           TEXT NOT NULL CHECK (vat_status IN ('DOMESTIC', 'OTHER', 'PRIVATE_PERSON')),
  -- 8-digit törzsszám of the Hungarian tax number (or of a HU community VAT number), if any.
  tax_id8              TEXT CHECK (tax_id8 IS NULL OR (length(tax_id8) = 8 AND tax_id8 NOT GLOB '*[^0-9]*')),
  -- 8-digit törzsszám of the VAT-group member's own tax number, if any.
  group_member_tax_id8 TEXT CHECK (group_member_tax_id8 IS NULL OR (length(group_member_tax_id8) = 8 AND group_member_tax_id8 NOT GLOB '*[^0-9]*')),
  -- searchKey() of the searchable fields (lower-case, accent-free).
  search_text          TEXT NOT NULL,
  data                 TEXT NOT NULL CHECK (json_valid(data)),
  archived             INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
) STRICT;
CREATE INDEX customers_tax_id8 ON customers (tax_id8) WHERE tax_id8 IS NOT NULL;
CREATE INDEX customers_group_member_tax_id8 ON customers (group_member_tax_id8) WHERE group_member_tax_id8 IS NOT NULL;

-- Product / service catalogue. "data" holds the complete Product object.
CREATE TABLE products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sku         TEXT,
  search_text TEXT NOT NULL,
  data        TEXT NOT NULL CHECK (json_valid(data)),
  archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE INDEX products_sku ON products (sku) WHERE sku IS NOT NULL;

-- Numbering series (számlatömbök).
CREATE TABLE series (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('invoice', 'proforma')),
  name         TEXT NOT NULL,
  pattern      TEXT NOT NULL,
  yearly_reset INTEGER NOT NULL CHECK (yearly_reset IN (0, 1)),
  next_seq     INTEGER NOT NULL CHECK (next_seq >= 1),
  seq_year     INTEGER CHECK (seq_year IS NULL OR seq_year BETWEEN 1000 AND 9999),
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  archived     INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at   TEXT NOT NULL
) STRICT;
-- At most one default series per kind.
CREATE UNIQUE INDEX series_single_default ON series (kind) WHERE is_default = 1;

-- Invoices (and díjbekérők). "doc" holds the immutable part of the Invoice object (everything except
-- status, paymentStatus, paidAmount, paidDate, navStatus, navTransactionId, navMessages,
-- cancelledById and updatedAt, which live in their own columns).
CREATE TABLE invoices (
  id                  TEXT PRIMARY KEY,
  number              TEXT UNIQUE,
  series_id           TEXT NOT NULL REFERENCES series (id),
  document_type       TEXT NOT NULL CHECK (document_type IN ('invoice', 'advance', 'final', 'modification', 'storno', 'proforma')),
  status              TEXT NOT NULL CHECK (status IN ('draft', 'issued', 'cancelled')),
  issue_date          TEXT NOT NULL,
  fulfillment_date    TEXT NOT NULL,
  due_date            TEXT,
  customer_id         TEXT REFERENCES customers (id),
  customer_name       TEXT NOT NULL,
  currency            TEXT NOT NULL,
  -- totals.grossAmount / totals.grossAmountHuf as canonical decimal strings.
  gross_amount        TEXT NOT NULL,
  gross_amount_huf    TEXT NOT NULL,
  original_invoice_id TEXT REFERENCES invoices (id),
  search_text         TEXT NOT NULL,
  doc                 TEXT NOT NULL CHECK (json_valid(doc)),
  content_hash        TEXT,
  -- mutable after issuance ------------------------------------------------------------------
  payment_status      TEXT NOT NULL CHECK (payment_status IN ('unpaid', 'partial', 'paid')),
  paid_amount         TEXT NOT NULL,
  paid_date           TEXT,
  nav_status          TEXT NOT NULL CHECK (nav_status IN ('not_applicable', 'not_configured', 'pending', 'processing', 'done', 'done_with_warnings', 'aborted', 'error')),
  nav_transaction_id  TEXT,
  nav_messages        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(nav_messages)),
  cancelled_by_id     TEXT REFERENCES invoices (id),
  -- ------------------------------------------------------------------------------------------
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  issued_at           TEXT,
  CHECK (status = 'draft' OR (number IS NOT NULL AND issued_at IS NOT NULL AND content_hash IS NOT NULL))
) STRICT;
-- Default listing (newest first) and created_desc.
CREATE INDEX invoices_issue_date ON invoices (issue_date, issued_at);
CREATE INDEX invoices_created_at ON invoices (created_at);
-- status is low-cardinality, so it leads only composite indexes whose next column narrows the search:
-- status + issue-date range (reports, exports, integrity check), the overdue filter
-- (payment_status IN ('unpaid', 'partial') AND due_date < ?), and the NAV work queue / status counts.
CREATE INDEX invoices_status_issue_date ON invoices (status, issue_date, issued_at);
CREATE INDEX invoices_overdue ON invoices (status, payment_status, due_date);
CREATE INDEX invoices_nav_status ON invoices (nav_status, status);
CREATE INDEX invoices_series ON invoices (series_id);
CREATE INDEX invoices_customer ON invoices (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX invoices_original ON invoices (original_invoice_id) WHERE original_invoice_id IS NOT NULL;
CREATE INDEX invoices_cancelled_by ON invoices (cancelled_by_id) WHERE cancelled_by_id IS NOT NULL;

-- New rows are always drafts; an issued invoice comes into existence only through the
-- draft → issued UPDATE (markIssued). This trigger also stops "INSERT OR REPLACE" from silently
-- deleting an issued invoice (REPLACE does not fire DELETE triggers unless recursive_triggers is on).
CREATE TRIGGER invoices_insert_guard
BEFORE INSERT ON invoices
FOR EACH ROW
WHEN NEW.status <> 'draft'
  OR EXISTS (SELECT 1 FROM invoices WHERE id = NEW.id AND status <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_INVOICE: új számla csak piszkozatként vehető fel, kiállított számla nem írható felül');
END;

CREATE TRIGGER invoices_insert_number_guard
BEFORE INSERT ON invoices
FOR EACH ROW
WHEN NEW.number IS NOT NULL
  AND EXISTS (SELECT 1 FROM invoices WHERE number = NEW.number AND status <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'DUPLICATE_INVOICE_NUMBER: ez a számlaszám már egy kiállított számláé');
END;

-- Status may only move draft → issued (markIssued) and issued → cancelled (sztornó).
CREATE TRIGGER invoices_status_transition
BEFORE UPDATE ON invoices
FOR EACH ROW
WHEN NEW.status IS NOT OLD.status
  AND NOT ((OLD.status = 'draft' AND NEW.status = 'issued')
        OR (OLD.status = 'issued' AND NEW.status = 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_INVOICE: tiltott állapotváltás (csak piszkozat → kiállított → sztornózott megengedett)');
END;

-- Once issued, only the "mutable after issuance" columns may change.
CREATE TRIGGER invoices_immutable_columns
BEFORE UPDATE ON invoices
FOR EACH ROW
WHEN OLD.status <> 'draft' AND (
     NEW.id IS NOT OLD.id
  OR NEW.number IS NOT OLD.number
  OR NEW.series_id IS NOT OLD.series_id
  OR NEW.document_type IS NOT OLD.document_type
  OR NEW.issue_date IS NOT OLD.issue_date
  OR NEW.fulfillment_date IS NOT OLD.fulfillment_date
  OR NEW.due_date IS NOT OLD.due_date
  OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.customer_name IS NOT OLD.customer_name
  OR NEW.currency IS NOT OLD.currency
  OR NEW.gross_amount IS NOT OLD.gross_amount
  OR NEW.gross_amount_huf IS NOT OLD.gross_amount_huf
  OR NEW.original_invoice_id IS NOT OLD.original_invoice_id
  OR NEW.search_text IS NOT OLD.search_text
  OR NEW.doc IS NOT OLD.doc
  OR NEW.content_hash IS NOT OLD.content_hash
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.issued_at IS NOT OLD.issued_at)
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_INVOICE: a kiállított számla tartalma nem módosítható');
END;

-- "UPDATE OR REPLACE" on a draft must not be able to delete an issued invoice by colliding with
-- its id or number.
CREATE TRIGGER invoices_update_id_guard
BEFORE UPDATE ON invoices
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  AND EXISTS (SELECT 1 FROM invoices WHERE id = NEW.id AND status <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_INVOICE: kiállított számla nem írható felül');
END;

CREATE TRIGGER invoices_update_number_guard
BEFORE UPDATE ON invoices
FOR EACH ROW
WHEN NEW.number IS NOT NULL
  AND NEW.number IS NOT OLD.number
  AND EXISTS (SELECT 1 FROM invoices WHERE number = NEW.number AND id <> OLD.id AND status <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'DUPLICATE_INVOICE_NUMBER: ez a számlaszám már egy kiállított számláé');
END;

CREATE TRIGGER invoices_delete_guard
BEFORE DELETE ON invoices
FOR EACH ROW
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_INVOICE: kiállított számla nem törölhető');
END;

-- Every attempt to report an invoice to NAV Online Számla.
CREATE TABLE nav_submissions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id          TEXT NOT NULL REFERENCES invoices (id),
  operation           TEXT NOT NULL CHECK (operation IN ('CREATE', 'MODIFY', 'STORNO')),
  environment         TEXT NOT NULL CHECK (environment IN ('test', 'production')),
  request_id          TEXT NOT NULL,
  transaction_id      TEXT,
  status              TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'processing', 'done', 'done_with_warnings', 'aborted', 'error')),
  invoice_data_base64 TEXT NOT NULL,
  messages            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(messages)),
  last_response_xml   TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;
CREATE INDEX nav_submissions_invoice ON nav_submissions (invoice_id, id);
CREATE INDEX nav_submissions_request ON nav_submissions (request_id);

-- What was sent to NAV is evidence: it can be annotated with the outcome but never rewritten or removed.
-- "INSERT OR REPLACE" with an existing id would delete the old row without firing the DELETE trigger
-- on connections without recursive_triggers, so inserts must not reuse an id.
CREATE TRIGGER nav_submissions_insert_guard
BEFORE INSERT ON nav_submissions
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM nav_submissions WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_NAV_SUBMISSION: meglévő NAV-beküldés nem írható felül');
END;

CREATE TRIGGER nav_submissions_immutable_payload
BEFORE UPDATE ON nav_submissions
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.invoice_id IS NOT OLD.invoice_id
  OR NEW.operation IS NOT OLD.operation
  OR NEW.environment IS NOT OLD.environment
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.invoice_data_base64 IS NOT OLD.invoice_data_base64
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_NAV_SUBMISSION: a NAV-nak beküldött adat nem módosítható');
END;

CREATE TRIGGER nav_submissions_delete_guard
BEFORE DELETE ON nav_submissions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_NAV_SUBMISSION: a NAV-beküldések naplója nem törölhető');
END;

-- MNB exchange-rate cache, keyed by the date that was asked for (rate_date may be earlier).
CREATE TABLE exchange_rates (
  currency       TEXT NOT NULL,
  requested_date TEXT NOT NULL,
  rate_date      TEXT NOT NULL,
  rate           TEXT NOT NULL,
  unit           INTEGER NOT NULL CHECK (unit >= 1),
  source         TEXT NOT NULL CHECK (source IN ('MNB')),
  fetched_at     TEXT NOT NULL,
  PRIMARY KEY (currency, requested_date)
) STRICT, WITHOUT ROWID;

-- Append-only, hash-chained audit log:
-- hash = sha256_hex(prev_hash || "\\n" || canonicalJson({at, actor, action, entityType, entityId, details})).
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('mcp', 'cli', 'web', 'system')),
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('invoice', 'customer', 'product', 'series', 'settings', 'nav')),
  entity_id   TEXT,
  details     TEXT NOT NULL CHECK (json_valid(details)),
  prev_hash   TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash        TEXT NOT NULL UNIQUE CHECK (length(hash) = 64)
) STRICT;
CREATE INDEX audit_log_entity ON audit_log (entity_id, id) WHERE entity_id IS NOT NULL;

-- New entries may only be appended to the end of the chain. Colliding with an existing id or hash is
-- refused too: "INSERT OR REPLACE" would otherwise delete that entry (without firing the DELETE
-- trigger on connections that have recursive_triggers OFF).
CREATE TRIGGER audit_log_append_guard
BEFORE INSERT ON audit_log
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM audit_log WHERE hash = NEW.hash)
  OR NEW.prev_hash IS NOT COALESCE((SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1), ${ZERO_HASH_LITERAL})
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: új bejegyzés csak a hash-lánc végére fűzhető');
END;

-- The id is only known after the insert (NEW.id is undefined in a BEFORE INSERT trigger when it is
-- not given explicitly): an explicit id below the end of the chain is refused here.
CREATE TRIGGER audit_log_append_order
AFTER INSERT ON audit_log
FOR EACH ROW
WHEN NEW.id IS NOT (SELECT MAX(id) FROM audit_log)
  OR NEW.prev_hash IS NOT COALESCE((SELECT hash FROM audit_log WHERE id < NEW.id ORDER BY id DESC LIMIT 1), ${ZERO_HASH_LITERAL})
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: új bejegyzés csak a hash-lánc végére fűzhető');
END;

CREATE TRIGGER audit_log_update_guard
BEFORE UPDATE ON audit_log
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: az auditnapló bejegyzései nem módosíthatók');
END;

CREATE TRIGGER audit_log_delete_guard
BEFORE DELETE ON audit_log
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY: az auditnapló bejegyzései nem törölhetők');
END;
`;

/**
 * The NAV environment (test / production) the NAV state of an invoice (nav_status, nav_transaction_id,
 * nav_messages) belongs to: a report accepted by the test system is no report in production. NULL when no NAV
 * system is involved yet (issued without a usable NAV connection, díjbekérő, older data without a submission).
 * Mutable after issuance like the other NAV columns – deliberately not covered by invoices_immutable_columns.
 * Existing invoices get the environment of the submission their NAV state comes from (the one with their
 * transaction id, else the latest one).
 *
 * Written as two subqueries, each naming the invoice only in its WHERE: the SQLite of the oldest supported Node.js
 * (3.47.2 in Node.js 22.13) does not resolve a column of the updated table in the ORDER BY of a correlated subquery
 * ("no such column: invoices.nav_transaction_id") – the one-subquery form stopped every new database there.
 */
const V2_NAV_ENVIRONMENT = /* sql */ `
ALTER TABLE invoices ADD COLUMN nav_environment TEXT CHECK (nav_environment IS NULL OR nav_environment IN ('test', 'production'));
UPDATE invoices SET nav_environment = COALESCE(
    (SELECT s.environment FROM nav_submissions AS s
      WHERE s.invoice_id = invoices.id AND invoices.nav_transaction_id IS NOT NULL AND s.transaction_id = invoices.nav_transaction_id
      ORDER BY s.id DESC LIMIT 1),
    (SELECT s.environment FROM nav_submissions AS s WHERE s.invoice_id = invoices.id ORDER BY s.id DESC LIMIT 1))
  WHERE status <> 'draft' AND EXISTS (SELECT 1 FROM nav_submissions AS s WHERE s.invoice_id = invoices.id);
`;

/**
 * The PDF of every issued document exactly as it was handed over (OpenSzamla.pdf): its bytes, SHA-256 and SHA3-512
 * fingerprints (uppercase hex, as NAV writes electronicInvoiceHash) and the program that rendered it. Append-only like the
 * issued invoices: a row is never changed or removed, none is stored for a draft, and each document has one original.
 *
 * invoice_documents_legacy lists the documents that were already issued when this table was created: what was handed
 * over for them is not known, so none of them ever gets an original (a later render is a regenerated copy). A draft of
 * that time is not in it – issued later, it gets its original like any other document.
 */
const V3_INVOICE_DOCUMENTS = /* sql */ `
CREATE TABLE invoice_documents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  kind       TEXT NOT NULL CHECK (kind = 'original'),
  sha256     TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9A-F]*'),
  sha3_512   TEXT NOT NULL CHECK (length(sha3_512) = 128 AND sha3_512 NOT GLOB '*[^0-9A-F]*'),
  size       INTEGER NOT NULL CHECK (size > 0 AND size = length(content)),
  content    BLOB NOT NULL,
  -- Name and version of the program that rendered it (in the PDF's footer and metadata).
  software   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (invoice_id, kind)
) STRICT;

CREATE TABLE invoice_documents_legacy (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices (id)
) STRICT, WITHOUT ROWID;
INSERT INTO invoice_documents_legacy (invoice_id) SELECT id FROM invoices WHERE status <> 'draft';

-- Only for an issued (or cancelled) document issued since originals are kept, once. Colliding with an existing id or
-- (invoice_id, kind) is refused too: "INSERT OR REPLACE" would otherwise delete the kept original.
CREATE TRIGGER invoice_documents_insert_guard
BEFORE INSERT ON invoice_documents
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id AND status <> 'draft')
  OR EXISTS (SELECT 1 FROM invoice_documents_legacy WHERE invoice_id = NEW.invoice_id)
  OR EXISTS (SELECT 1 FROM invoice_documents WHERE id = NEW.id OR (invoice_id = NEW.invoice_id AND kind = NEW.kind))
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_DOCUMENT: eredeti PDF csak kiállított bizonylathoz és bizonylatonként egyszer menthető');
END;

CREATE TRIGGER invoice_documents_update_guard
BEFORE UPDATE ON invoice_documents
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_DOCUMENT: a megőrzött eredeti PDF nem módosítható');
END;

CREATE TRIGGER invoice_documents_delete_guard
BEFORE DELETE ON invoice_documents
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_DOCUMENT: a megőrzött eredeti PDF nem törölhető');
END;

CREATE TRIGGER invoice_documents_legacy_insert_guard
BEFORE INSERT ON invoice_documents_legacy
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_DOCUMENT: a megőrzés előtt kiállított bizonylatok listája nem bővíthető');
END;

CREATE TRIGGER invoice_documents_legacy_update_guard
BEFORE UPDATE ON invoice_documents_legacy
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_DOCUMENT: a megőrzés előtt kiállított bizonylatok listája nem módosítható');
END;

CREATE TRIGGER invoice_documents_legacy_delete_guard
BEFORE DELETE ON invoice_documents_legacy
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_DOCUMENT: a megőrzés előtt kiállított bizonylatok listája nem módosítható');
END;
`;

/**
 * The payment ledger: every amount recorded on an issued document – a payment received, a refund paid back to the buyer
 * (on a crediting document or on the storno of a paid invoice), the reversal of an earlier entry, the díjbekérő payment
 * carried over when the invoice made from it was issued, a markPaid at issue, the 0 Ft document marked settled – is a row
 * of payments, and payment_allocations records how the settlement of the document's invoice chain distributed it among
 * the documents of the chain (a payment of the corrected total on the original also covers its modification). Both are
 * append-only: a later redistribution (e.g. a modification issued afterwards takes over the overpayment that covers it,
 * or a payment dated earlier is recorded later) is recorded as new allocation rows – the allocation of a payment to a
 * document is the sum of its rows. invoices.paid_amount, paid_date and payment_status follow from them. Amounts are
 * signed canonical decimals in the document's currency.
 *
 * The payments of an existing database are taken over from its 'invoice.payment' audit entries by the program
 * (OpenSzamla.backfillPaymentLedger) – the settlement has to be replayed, which SQL cannot do.
 */
const V4_PAYMENT_LEDGER = /* sql */ `
CREATE TABLE payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   TEXT NOT NULL REFERENCES invoices (id),
  payment_date TEXT NOT NULL,
  amount       TEXT NOT NULL,
  -- manual: recorded as a payment (MCP, web); mark_paid: at issue (markPaid); proforma: carried over from a díjbekérő.
  source       TEXT NOT NULL CHECK (source IN ('manual', 'mark_paid', 'proforma')),
  -- The number of the díjbekérő a carried payment came from; NULL otherwise.
  reference    TEXT,
  -- The 'invoice.payment' audit entry recording it (the payments of a díjbekérő carried over share one).
  audit_id     INTEGER NOT NULL REFERENCES audit_log (id),
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX payments_invoice ON payments (invoice_id, id);
CREATE INDEX payments_date ON payments (payment_date, id);
CREATE INDEX payments_audit ON payments (audit_id);

CREATE TABLE payment_allocations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments (id),
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  amount     TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX payment_allocations_payment ON payment_allocations (payment_id, invoice_id);
CREATE INDEX payment_allocations_invoice ON payment_allocations (invoice_id, payment_id);

-- Only for an issued (or cancelled) document. Colliding with an existing id is refused too: "INSERT OR REPLACE" would
-- otherwise delete the recorded row.
CREATE TRIGGER payments_insert_guard
BEFORE INSERT ON payments
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id AND status <> 'draft')
  OR EXISTS (SELECT 1 FROM payments WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_PAYMENT: befizetés csak kiállított bizonylatra rögzíthető, a rögzített befizetés nem írható felül');
END;

CREATE TRIGGER payments_update_guard
BEFORE UPDATE ON payments
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_PAYMENT: a rögzített befizetés nem módosítható');
END;

CREATE TRIGGER payments_delete_guard
BEFORE DELETE ON payments
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_PAYMENT: a rögzített befizetés nem törölhető');
END;

CREATE TRIGGER payment_allocations_insert_guard
BEFORE INSERT ON payment_allocations
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id AND status <> 'draft')
  OR EXISTS (SELECT 1 FROM payment_allocations WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_PAYMENT: befizetés csak kiállított bizonylatra osztható fel, a rögzített felosztás nem írható felül');
END;

CREATE TRIGGER payment_allocations_update_guard
BEFORE UPDATE ON payment_allocations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_PAYMENT: a befizetés rögzített felosztása nem módosítható');
END;

CREATE TRIGGER payment_allocations_delete_guard
BEFORE DELETE ON payment_allocations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_PAYMENT: a befizetés rögzített felosztása nem törölhető');
END;
`;

/** All migrations in application order. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1_INITIAL },
  { version: 2, sql: V2_NAV_ENVIRONMENT },
  { version: 3, sql: V3_INVOICE_DOCUMENTS },
  { version: 4, sql: V4_PAYMENT_LEDGER },
];

/** The schema version this build of the program expects. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
