CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','cashier')),
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  price INTEGER NOT NULL,          -- piastres
  cost INTEGER NOT NULL DEFAULT 0, -- piastres
  by_weight INTEGER NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE barcodes (
  code TEXT PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id)
);

CREATE TABLE sales (
  id INTEGER PRIMARY KEY,
  no INTEGER NOT NULL UNIQUE,      -- sequential invoice number
  user_id INTEGER NOT NULL REFERENCES users(id),
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  total INTEGER NOT NULL,
  pay_method TEXT NOT NULL CHECK (pay_method IN ('cash','card','mixed')),
  created_at INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE sale_items (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  qty REAL NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  delta REAL NOT NULL,
  reason TEXT NOT NULL,            -- sale | return | adjust | purchase
  ref_id INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

-- Sales are append-only: no edits, no deletes. Corrections go through returns.
CREATE TRIGGER sales_no_update BEFORE UPDATE ON sales BEGIN SELECT RAISE(ABORT, 'sales are immutable'); END;
CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales BEGIN SELECT RAISE(ABORT, 'sales are immutable'); END;
CREATE TRIGGER items_no_update BEFORE UPDATE ON sale_items BEGIN SELECT RAISE(ABORT, 'sales are immutable'); END;
CREATE TRIGGER items_no_delete BEFORE DELETE ON sale_items BEGIN SELECT RAISE(ABORT, 'sales are immutable'); END;
