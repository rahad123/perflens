import type { Pool } from 'pg';

export async function ensureDevelopmentData(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK (price_cents >= 0));
    CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id);
    CREATE TABLE IF NOT EXISTS order_items (id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0));
    CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items(product_id);
  `);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(73001)');
    const { rows: [{ count }] } = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM customers');
    if (Number(count) === 0) {
      await client.query(`
        INSERT INTO customers(name,email) SELECT 'Customer ' || n, 'customer' || n || '@example.test' FROM generate_series(1,2000) n;
        INSERT INTO products(name,price_cents) SELECT 'Product ' || n, 500 + n * 13 FROM generate_series(1,500) n;
        INSERT INTO orders(customer_id,status,created_at) SELECT 1 + (n % 2000), CASE WHEN n % 3 = 0 THEN 'pending' ELSE 'completed' END, now() - n * interval '1 minute' FROM generate_series(1,20000) n;
        INSERT INTO order_items(order_id,product_id,quantity,unit_price_cents) SELECT o.id, p.id, 1 + (o.id % 3), p.price_cents FROM orders o CROSS JOIN generate_series(1,4) s JOIN products p ON p.id = 1 + ((o.id + s) % 500);
      `);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await pool.query('ANALYZE');
}
