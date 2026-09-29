const express = require('express');
const axios = require('axios');
const http = require('http');
const winston = require('winston');
const CircuitBreaker = require('opossum');
const promClient = require('prom-client');

const PORT = process.env.PORT || 3000;
const DOWNSTREAM_URL = process.env.PRODUCT_SERVICE_URL || 'http://toxiproxy:8080/products';

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

// Setup Prometheus registry for basic metrics (optional, for observability)
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// --- CONNECTION POOLS ---

// Non-optimized agent (no Keep-Alive, default connection churn)
const naiveAgent = new http.Agent({
  keepAlive: false
});

// Highly optimized agent (HTTP Keep-Alive enabled)
const optimizedAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,      // Max concurrent connections per host
  maxFreeSockets: 10,   // Max connections to keep open in the idle pool
  timeout: 60000        // Close idle sockets after 60s
});

// --- CIRCUIT BREAKER SETTINGS ---

const callProductServiceResilient = async () => {
  // Use the optimized agent
  const response = await axios.get(DOWNSTREAM_URL, {
    httpAgent: optimizedAgent,
    // Note: Axios timeout can be high because Opossum's timeout (800ms) will trip sooner.
    timeout: 5000 
  });
  return response.data;
};

const breakerOptions = {
  timeout: 800,                    // Fail request if it takes > 800ms
  errorThresholdPercentage: 50,   // Open the circuit if 50% of requests in window fail
  resetTimeout: 10000,            // Wait 10s in OPEN state before trying HALF-OPEN
  volumeThreshold: 10,            // Minimum 10 requests to start calculations
  capacity: 50                    // Bulkhead: Max 50 concurrent requests in flight
};

const productServiceBreaker = new CircuitBreaker(callProductServiceResilient, breakerOptions);

// Fallback behavior
productServiceBreaker.fallback(() => {
  return { 
    status: 'degraded', 
    data: [], 
    message: 'Product catalog temporarily unavailable. Serving cached layout.' 
  };
});

// Logger telemetry on breaker state changes
productServiceBreaker.on('open', () => {
  logger.error('Circuit Breaker OPENED - Serving fallback data');
});

productServiceBreaker.on('close', () => {
  logger.info('Circuit Breaker CLOSED - Resuming normal operation');
});

productServiceBreaker.on('halfOpen', () => {
  logger.info('Circuit Breaker HALF-OPEN - Testing downstream health');
});

// --- EXPRESS APPLICATION ---

const app = express();

app.use((req, res, next) => {
  // Simple request logging
  next();
});

// NAIVE PATH: No Keep-Alive, No Circuit Breaker
app.get('/products/naive', async (req, res) => {
  try {
    const response = await axios.get(DOWNSTREAM_URL, {
      httpAgent: naiveAgent,
      timeout: 30000 // Standard long timeout (30 seconds)
    });
    res.json(response.data);
  } catch (error) {
    logger.error('Naive path request failed', { message: error.message, code: error.code });
    res.status(500).json({ error: 'Failed to retrieve products from product service', details: error.message });
  }
});

// RESILIENT PATH: Optimized connection pool + Circuit Breaker + Bulkhead + Fallback
app.get('/products/resilient', async (req, res) => {
  try {
    const data = await productServiceBreaker.fire();
    // If the circuit breaker returns the fallback data (which has a "degraded" status),
    // we can return it with 200 (graceful degradation) or configure as needed.
    res.json(data);
  } catch (error) {
    // This catch block handles unexpected failures that bypass or escape the breaker / fallback
    logger.error('Resilient path caught error', { message: error.message });
    res.status(500).json({ error: 'System error', details: error.message });
  }
});

// Observability metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'api-gateway' });
});

app.listen(PORT, () => {
  logger.info(`API Gateway running on port ${PORT}`);
  logger.info(`Downstream Product Service URL: ${DOWNSTREAM_URL}`);
});
