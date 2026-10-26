-- Treasury: one append-only ledger of every money movement; balances are always SUM(delta) per account.
ALTER TABLE expenses ADD COLUMN paid_from TEXT NOT NULL DEFAULT 'cash';   -- 'cash' | 'bank'
ALTER TABLE expenses ADD COLUMN from_drawer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE expenses ADD COLUMN shift_id INTEGER;
ALTER TABLE expenses ADD COLUMN voided INTEGER NOT NULL DEFAULT 0;

CREATE TABLE treasury_entries (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL CHECK (account IN ('cash','bank')),
  delta INTEGER NOT NULL,                 -- piastres, + in / - out
  kind TEXT NOT NULL,
  ref_table TEXT,
  ref_id INTEGER,
  shift_id INTEGER REFERENCES shifts(id),
  in_drawer INTEGER NOT NULL DEFAULT 0,   -- 1 = this cash moved through the cashier's drawer
  user_id INTEGER,
  approved_by INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX treasury_account ON treasury_entries(account, created_at);
CREATE INDEX treasury_shift ON treasury_entries(shift_id) WHERE in_drawer=1;
CREATE INDEX treasury_kind ON treasury_entries(kind);
CREATE TRIGGER treasury_no_update BEFORE UPDATE ON treasury_entries BEGIN SELECT RAISE(ABORT, 'treasury is immutable'); END;
CREATE TRIGGER treasury_no_delete BEFORE DELETE ON treasury_entries BEGIN SELECT RAISE(ABORT, 'treasury is immutable'); END;

-- Backfill from history so balances are consistent from day one (opening balance is set later via a count).
INSERT INTO treasury_entries(account,delta,kind,ref_table,ref_id,shift_id,in_drawer,user_id,created_at)
  SELECT 'cash', total, 'sale', 'sales', id, shift_id, 1, user_id, created_at FROM sales WHERE pay_method IN ('cash','mixed');
INSERT INTO treasury_entries(account,delta,kind,ref_table,ref_id,shift_id,in_drawer,user_id,created_at)
  SELECT 'bank', total, 'sale', 'sales', id, shift_id, 0, user_id, created_at FROM sales WHERE pay_method='card';
INSERT INTO treasury_entries(account,delta,kind,ref_table,ref_id,shift_id,in_drawer,user_id,created_at)
  SELECT 'cash', paid, 'sale', 'sales', id, shift_id, 1, user_id, created_at FROM sales WHERE pay_method='credit' AND paid>0;
INSERT INTO treasury_entries(account,delta,kind,ref_table,ref_id,shift_id,in_drawer,user_id,created_at)
  SELECT 'cash', -total, 'sale_return', 'returns', id, shift_id, 1, user_id, created_at FROM returns WHERE refund_method='cash';
INSERT INTO treasury_entries(account,delta,kind,ref_table,ref_id,shift_id,in_drawer,user_id,created_at)
  SELECT 'bank', -total, 'sale_return', 'returns', id, shift_id, 0, user_id, created_at FROM returns WHERE refund_method='card';
INSERT INTO treasury_entries(account,delta,kind,ref_table,ref_id,shift_id,in_drawer,user_id,created_at)
  SELECT CASE method WHEN 'card' THEN 'bank' ELSE 'cash' END, -delta, 'customer_payment', 'customer_ledger', id, shift_id,
         CASE method WHEN 'card' THEN 0 ELSE 1 END, user_id, created_at FROM customer_ledger WHERE kind='payment';
INSERT INTO treasury_entries(account,delta,kind,ref_table,ref_id,in_drawer,user_id,created_at)
  SELECT 'cash', -amount, 'expense', 'expenses', id, 0, user_id, created_at FROM expenses;
INSERT INTO treasury_entries(account,delta,kind,ref_table,ref_id,shift_id,in_drawer,user_id,created_at)
  SELECT 'cash', counted_cash - expected_cash, 'shift_diff', 'shifts', id, id, 0, user_id, closed_at FROM shifts
  WHERE closed_at IS NOT NULL AND counted_cash IS NOT NULL AND counted_cash <> expected_cash;
