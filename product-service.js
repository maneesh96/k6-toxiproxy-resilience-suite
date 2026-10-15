const express = require('express');
const { Pool } = require('pg');
const winston = require('winston');

const PORT = parseInt(process.env.PORT || '3001', 10);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// Credentials come from the environment only (see .env.example); there are no
// hard-coded defaults so a missing .env fails loudly instead of using weak creds.
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', { error: err.message });
});

const app = express();

app.use((req, res, next) => {
  logger.debug(`Received request: ${req.method} ${req.url}`);
  next();
});

// Product catalog endpoint. A database failure is reported as 503 rather than
// masked with canned data, so the resilience experiments measure real behaviour.
app.get('/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, price, description, stock FROM products ORDER BY id');
    res.json(result.rows);
  } catch (error) {
    logger.error('Database query failed', { error: error.message });
    res.status(503).json({ error: 'Product database unavailable' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'product-service' });
});

app.listen(PORT, () => {
  logger.info(`Product Service running on port ${PORT}`);
});
