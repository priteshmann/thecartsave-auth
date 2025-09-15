const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const HOST = process.env.HOST;
const DATABASE_URL = process.env.DATABASE_URL;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
let pool;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  console.log('No DATABASE_URL provided');
}

// Health check
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  if (pool) {
    try {
      await pool.query('SELECT NOW()');
      dbStatus = 'connected';
    } catch (err) {
      console.error('DB health check failed:', err.message);
    }
  }
  
  res.json({
    status: 'ok',
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
});

// Debug endpoint
app.get('/debug', (req, res) => {
  res.json({
    env_vars: {
      SHOPIFY_API_KEY: !!SHOPIFY_API_KEY,
      SHOPIFY_API_SECRET: !!SHOPIFY_API_SECRET,
      HOST: !!HOST,
      DATABASE_URL: !!DATABASE_URL
    },
    pool_status: !!pool,
    timestamp: new Date().toISOString()
  });
});

// Root route
app.get('/', (req, res) => {
  const shop = req.query.shop || 'thecartsave-dev.myshopify.com';
  res.redirect(`/oauth?shop=${shop}`);
});

// OAuth initiation
app.get('/oauth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  const scope = 'read_products,write_checkouts,read_orders,read_customers,write_marketing_events,write_discounts';
  const redirect_uri = `${HOST}/oauth/callback`;
  const state = Math.random().toString(36).substring(2, 15);
  
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${scope}&redirect_uri=${redirect_uri}&state=${state}`;
  res.redirect(authUrl);
});

// OAuth callback
app.get('/oauth/callback', async (req, res) => {
  const { code, shop } = req.query;

  if (!code || !shop) {
    return res.status(400).send('Missing required parameters');
  }

  try {
    // Get access token
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code: code
      })
    });

    const tokenData = await tokenResponse.json();
    
    if (!tokenData.access_token) {
      throw new Error('Failed to get access token');
    }

    console.log('✅ Access token received for shop:', shop);

    // Store in database
    if (pool) {
      try {
        const result = await pool.query(
          `INSERT INTO shops (shop, access_token, plan, settings, created_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (shop) 
           DO UPDATE SET access_token = $2
           RETURNING *`,
          [shop, tokenData.access_token, 'free', JSON.stringify({})]
        );
        console.log('✅ Shop data stored:', result.rows[0].shop);
      } catch (dbError) {
        console.error('❌ Database error:', dbError.message);
      }
    } else {
      console.error('❌ No database connection');
    }

    // Success page
    res.send(`
      <html>
        <body style="font-family: Arial; text-align: center; margin-top: 100px;">
          <h1 style="color: green;">✅ TheCartSave Installed!</h1>
          <p>Shop: <strong>${shop}</strong></p>
          <p>You can close this window.</p>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).send('Installation failed: ' + error.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
