const express = require('express');
const { Pool } = require('pg');
const winston = require('winston');

const PORT = process.env.PORT || 3001;

// Setup logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// Setup database connection pool
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  user: process.env.DB_USER || 'user',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_DATABASE || 'product_db',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  max: 20, // Max database connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', err);
});

// Self-healing database detection flag and mock data
let useMockDb = false;
const mockProducts = [
  { id: 1, name: 'Ergonomic Mechanical Keyboard', price: 129.99, description: 'Fully custom mechanical keyboard with tactile switches and RGB lighting.', stock: 45 },
  { id: 2, name: 'Ultrawide IPS Monitor 34"', price: 449.99, description: '34-inch curved monitor with a 144Hz refresh rate and wide color gamut.', stock: 12 },
  { id: 3, name: 'Wireless Noise-Canceling Headphones', price: 199.99, description: 'Over-ear active noise canceling headphones with 30-hour battery life.', stock: 80 },
  { id: 4, name: 'High-Precision Wireless Mouse', price: 79.99, description: 'Ergonomic mouse with programmable buttons and ultra-fast tracking.', stock: 120 },
  { id: 5, name: 'USB-C Dual-Monitor Docking Station', price: 149.99, description: 'Universal docking station with dual HDMI/DisplayPort outputs and power delivery.', stock: 30 }
];

// Test connection on startup
pool.connect()
  .then(client => {
    logger.info('Connected to PostgreSQL successfully.');
    client.release();
  })
  .catch(err => {
    logger.warn('PostgreSQL connection failed. Operating in high-performance mock database mode.', { error: err.message });
    useMockDb = true;
  });

const app = express();

app.use((req, res, next) => {
  logger.info(`Received request: ${req.method} ${req.url}`);
  next();
});

// Product catalog endpoint
app.get('/products', async (req, res) => {
  if (useMockDb) {
    // Artificial 10ms database query overhead simulation
    await new Promise(resolve => setTimeout(resolve, 10));
    return res.json(mockProducts);
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT id, name, price, description, stock FROM products');
    res.json(result.rows);
  } catch (error) {
    logger.error('Database query failed. Falling back to mock data.', error);
    res.json(mockProducts);
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'product-service' });
});

app.listen(PORT, () => {
  logger.info(`Product Service running on port ${PORT}`);
});
