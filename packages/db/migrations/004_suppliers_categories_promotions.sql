-- One party table for customers and suppliers; purchases and supplier payments; categories; promotions.
ALTER TABLE customers ADD COLUMN is_customer INTEGER NOT NULL DEFAULT 1;
ALTER TABLE customers ADD COLUMN is_supplier INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN code TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN tax_no TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN notes TEXT NOT NULL DEFAULT '';

CREATE TABLE purchase_invoices (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES customers(id),
  supplier_ref TEXT NOT NULL DEFAULT '',
  invoice_date INTEGER NOT NULL,
  due_date INTEGER,
  total INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL REFERENCES users(id),
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX purchase_supplier ON purchase_invoices(supplier_id, invoice_date);

CREATE TABLE purchase_items (
  id INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchase_invoices(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL,
  unit_cost INTEGER NOT NULL,
  expiry INTEGER
);
CREATE INDEX purchase_items_purchase ON purchase_items(purchase_id);
CREATE TRIGGER pitems_no_update BEFORE UPDATE ON purchase_items BEGIN SELECT RAISE(ABORT, 'purchase items are immutable'); END;
CREATE TRIGGER pitems_no_delete BEFORE DELETE ON purchase_items BEGIN SELECT RAISE(ABORT, 'purchase items are immutable'); END;

CREATE TABLE supplier_payments (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES customers(id),
  purchase_id INTEGER REFERENCES purchase_invoices(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  account TEXT NOT NULL CHECK (account IN ('cash','bank')),
  in_drawer INTEGER NOT NULL DEFAULT 0,
  shift_id INTEGER REFERENCES shifts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX supplier_payments_purchase ON supplier_payments(purchase_id);

-- + = we owe the supplier more, - = we paid / cancelled
CREATE TABLE supplier_ledger (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES customers(id),
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('purchase','payment','void','adjust')),
  ref_id INTEGER,
  user_id INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX supplier_ledger_supplier ON supplier_ledger(supplier_id);
CREATE TRIGGER sledger_no_update BEFORE UPDATE ON supplier_ledger BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END;
CREATE TRIGGER sledger_no_delete BEFORE DELETE ON supplier_ledger BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END;

ALTER TABLE batches ADD COLUMN purchase_id INTEGER;

CREATE TABLE promotions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('percent','amount','bxgy')),
  target TEXT NOT NULL CHECK (target IN ('product','category')),
  target_id INTEGER NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,       -- percent (1-100) or piastres off per unit
  buy_qty INTEGER NOT NULL DEFAULT 0,
  get_qty INTEGER NOT NULL DEFAULT 0,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER,
  created_at INTEGER NOT NULL
);

ALTER TABLE sale_items ADD COLUMN promo_id INTEGER;
ALTER TABLE sale_items ADD COLUMN promo_discount INTEGER NOT NULL DEFAULT 0; -- part of `discount` that came from a promotion
