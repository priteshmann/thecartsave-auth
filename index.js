const express = require('express');

const app = express();

// Ultra-minimal test - just basic Express
app.get('/', (req, res) => {
  res.json({
    status: 'working',
    timestamp: new Date().toISOString(),
    message: 'Basic Express server is running'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env_check: {
      SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY ? 'present' : 'missing',
      SHOPIFY_API_SECRET: process.env.SHOPIFY_API_SECRET ? 'present' : 'missing',
      HOST: process.env.HOST || 'not set',
      DATABASE_URL: process.env.DATABASE_URL ? 'present' : 'missing'
    }
  });
});

// Export for Vercel
module.exports = app;
