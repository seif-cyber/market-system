-- migrate:no-fk
-- Adds shifts, customers/credit, returns, expenses, expiry batches; rebuilds `sales` to allow pay_method 'credit'.

CREATE TABLE shifts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  opening_cash INTEGER NOT NULL,
  counted_cash INTEGER,
  expected_cash INTEGER
);
CREATE UNIQUE INDEX one_open_shift_per_user ON shifts(user_id) WHERE closed_at IS NULL;

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  credit_limit INTEGER NOT NULL DEFAULT 0, -- 0 = credit not allowed
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE sales_new (
  id INTEGER PRIMARY KEY,
  no INTEGER NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  total INTEGER NOT NULL,
  pay_method TEXT NOT NULL CHECK (pay_method IN ('cash','card','mixed','credit')),
  created_at INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  shift_id INTEGER REFERENCES shifts(id),
  customer_id INTEGER REFERENCES customers(id),
  paid INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sales_new (id,no,user_id,subtotal,discount,tax,total,pay_method,created_at,prev_hash,hash,paid)
  SELECT id,no,user_id,subtotal,discount,tax,total,pay_method,created_at,prev_hash,hash,total FROM sales;
DROP TABLE sales;
ALTER TABLE sales_new RENAME TO sales;
CREATE TRIGGER sales_no_update BEFORE UPDATE ON sales BEGIN SELECT RAISE(ABORT, 'sales are immutable'); END;
CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales BEGIN SELECT RAISE(ABORT, 'sales are immutable'); END;
CREATE INDEX sales_created ON sales(created_at);
CREATE INDEX sales_shift ON sales(shift_id);

ALTER TABLE sale_items ADD COLUMN cost INTEGER NOT NULL DEFAULT 0; -- unit cost at time of sale
CREATE INDEX sale_items_product ON sale_items(product_id);
CREATE INDEX sale_items_sale ON sale_items(sale_id);

CREATE TABLE customer_ledger (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  delta INTEGER NOT NULL,                 -- + customer owes more, - customer paid / refunded
  kind TEXT NOT NULL CHECK (kind IN ('sale','payment','adjust')),
  ref_id INTEGER,
  method TEXT,
  shift_id INTEGER,
  user_id INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ledger_customer ON customer_ledger(customer_id);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON customer_ledger BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON customer_ledger BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END;

CREATE TABLE returns (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  shift_id INTEGER REFERENCES shifts(id),
  total INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  refund_method TEXT NOT NULL CHECK (refund_method IN ('cash','card','credit')),
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE return_items (
  id INTEGER PRIMARY KEY,
  return_id INTEGER NOT NULL REFERENCES returns(id),
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL,
  amount INTEGER NOT NULL,
  cost INTEGER NOT NULL                   -- total cost of the returned qty
);
CREATE INDEX returns_created ON returns(created_at);
CREATE TRIGGER returns_no_update BEFORE UPDATE ON returns BEGIN SELECT RAISE(ABORT, 'returns are immutable'); END;
CREATE TRIGGER returns_no_delete BEFORE DELETE ON returns BEGIN SELECT RAISE(ABORT, 'returns are immutable'); END;
CREATE TRIGGER ritems_no_update BEFORE UPDATE ON return_items BEGIN SELECT RAISE(ABORT, 'returns are immutable'); END;
CREATE TRIGGER ritems_no_delete BEFORE DELETE ON return_items BEGIN SELECT RAISE(ABORT, 'returns are immutable'); END;

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX expenses_created ON expenses(created_at);

CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL,
  expiry INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX batches_product ON batches(product_id, expiry);

CREATE TABLE held_carts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
