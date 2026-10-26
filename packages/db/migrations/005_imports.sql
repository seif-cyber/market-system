-- Every CSV/Excel import is a batch, so the last one can be undone.
CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('products','parties')),
  label TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);
CREATE TABLE import_items (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created','updated')),
  before TEXT,                              -- JSON of the fields before an update
  stock_delta REAL NOT NULL DEFAULT 0       -- stock this import added to an existing product
);
CREATE INDEX import_items_batch ON import_items(batch_id);
ALTER TABLE stock_movements ADD COLUMN import_id INTEGER;
ALTER TABLE batches ADD COLUMN import_id INTEGER;
