-- Database initialization script for k6-toxiproxy-resilience-suite

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  description TEXT,
  stock INT DEFAULT 100,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed initial products
INSERT INTO products (name, price, description, stock) VALUES
  ('Ergonomic Mechanical Keyboard', 129.99, 'Fully custom mechanical keyboard with tactile switches and RGB lighting.', 45),
  ('Ultrawide IPS Monitor 34"', 449.99, '34-inch curved monitor with a 144Hz refresh rate and wide color gamut.', 12),
  ('Wireless Noise-Canceling Headphones', 199.99, 'Over-ear active noise canceling headphones with 30-hour battery life.', 80),
  ('High-Precision Wireless Mouse', 79.99, 'Ergonomic mouse with programmable buttons and ultra-fast tracking.', 120),
  ('USB-C Dual-Monitor Docking Station', 149.99, 'Universal docking station with dual HDMI/DisplayPort outputs and power delivery.', 30)
ON CONFLICT DO NOTHING;
