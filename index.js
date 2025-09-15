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

// Database connection - Create pool only when needed
let pool;

function getPool() {
  if (!pool && DATABASE_URL) {
    console.log('Creating new database pool...');
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      },
      // Vercel-specific optimizations
      max: 1, // Limit connections for serverless
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    
    pool.on('error', (err) => {
      console.error('Database pool error:', err);
    });
  }
  return pool;
}

// Health check with better error handling
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  let dbError = null;
  
  if (DATABASE_URL) {
    try {
      const dbPool = getPool();
      if (dbPool) {
        console.log('Testing database connection...');
        const result = await dbPool.query('SELECT NOW() as current_time');
        dbStatus = 'connected';
        console.log('✅ Database connected successfully:', result.rows[0]);
      }
    } catch (err) {
      console.error('❌ DB health check failed:', err.message);
      console.error('Error details:', err);
      dbStatus = 'error';
      dbError = err.message;
    }
  } else {
    console.log('❌ No DATABASE_URL provided');
    dbError = 'DATABASE_URL not configured';
  }
  
  res.json({
    status: dbStatus === 'connected' ? 'ok' : 'degraded',
    database: dbStatus,
    database_error: dbError,
    database_url_exists: !!DATABASE_URL,
    timestamp: new Date().toISOString()
  });
});

// Debug endpoint with more details
app.get('/debug', (req, res) => {
  res.json({
    env_vars: {
      SHOPIFY_API_KEY: !!SHOPIFY_API_KEY,
      SHOPIFY_API_SECRET: !!SHOPIFY_API_SECRET,
      HOST: !!HOST,
      DATABASE_URL: !!DATABASE_URL,
      DATABASE_URL_PREVIEW: DATABASE_URL ? DATABASE_URL.substring(0, 30) + '...' : null
    },
    pool_status: !!pool,
    node_version: process.version,
    platform: process.platform,
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

// OAuth callback with improved database handling
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

    // Store in database with better error handling
    if (DATABASE_URL) {
      try {
        const dbPool = getPool();
        if (dbPool) {
          const result = await dbPool.query(
            `INSERT INTO shops (shop, access_token, plan, settings, created_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (shop) 
             DO UPDATE SET access_token = $2, updated_at = NOW()
             RETURNING *`,
            [shop, tokenData.access_token, 'free', JSON.stringify({})]
          );
          console.log('✅ Shop data stored:', result.rows[0].shop);
        } else {
          throw new Error('Failed to create database pool');
        }
      } catch (dbError) {
        console.error('❌ Database error:', dbError.message);
        console.error('❌ Database error details:', dbError);
        // Don't fail the OAuth flow due to DB issues
      }
    } else {
      console.error('❌ No DATABASE_URL configured');
    }

    // Success page
    res.send(`
      <html>
        <head>
          <title>TheCartSave - Installation Complete</title>
        </head>
        <body style="font-family: Arial, sans-serif; text-align: center; margin-top: 100px; background-color: #f5f5f5;">
          <div style="max-width: 500px; margin: 0 auto; padding: 40px; background: white; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h1 style="color: #28a745; margin-bottom: 20px;">✅ TheCartSave Installed Successfully!</h1>
            <p style="font-size: 16px; color: #333;">Shop: <strong>${shop}</strong></p>
            <p style="color: #666; margin-top: 30px;">You can now close this window and return to your Shopify admin.</p>
          </div>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('❌ OAuth error:', error);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial; text-align: center; margin-top: 100px;">
          <h1 style="color: red;">❌ Installation Failed</h1>
          <p>Error: ${error.message}</p>
          <p>Please try again or contact support.</p>
        </body>
      </html>
    `);
  }
});

// Graceful shutdown for Vercel
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing database pool...');
  if (pool) {
    await pool.end();
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Database configured: ${!!DATABASE_URL}`);
});

// Export for Vercel
module.exports = app;
