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

// Database connection with error handling
let pool;
try {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  
  console.log('Connecting to database with URL:', DATABASE_URL.replace(/:[^:@]*@/, ':***@'));
  
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  // Test the connection
  pool.on('connect', () => {
    console.log('Connected to PostgreSQL database');
  });

  pool.on('error', (err) => {
    console.error('Database pool error:', err);
  });

} catch (error) {
  console.error('Database connection setup failed:', error.message);
}

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    let dbStatus = 'disconnected';
    
    if (pool) {
      const result = await pool.query('SELECT NOW()');
      dbStatus = 'connected';
    }
    
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      environment: {
        node_version: process.version,
        has_shopify_key: !!SHOPIFY_API_KEY,
        has_shopify_secret: !!SHOPIFY_API_SECRET,
        has_host: !!HOST,
        has_database_url: !!DATABASE_URL
      }
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({
      status: 'error',
      message: error.message,
      database: 'error'
    });
  }
});

// Debug endpoint
app.get('/debug', (req, res) => {
  try {
    res.json({
      environment_variables: {
        SHOPIFY_API_KEY: SHOPIFY_API_KEY ? 'SET' : 'MISSING',
        SHOPIFY_API_SECRET: SHOPIFY_API_SECRET ? 'SET' : 'MISSING',
        HOST: HOST || 'MISSING',
        DB_HOST: DB_HOST || 'MISSING',
        DB_PORT: DB_PORT || 'MISSING', 
        DB_NAME: DB_NAME || 'MISSING',
        DB_USER: DB_USER || 'MISSING',
        DB_PASS: DB_PASS ? 'SET' : 'MISSING',
        NODE_ENV: process.env.NODE_ENV || 'not set'
      },
      database_connection: pool ? 'initialized' : 'not initialized',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Debug endpoint error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Root route
app.get('/', (req, res) => {
  const shop = req.query.shop || 'thecartsave-dev.myshopify.com';
  console.log('Root accessed, redirecting to /oauth with shop =', shop);
  res.redirect(`/oauth?shop=${shop}`);
});

// OAuth initiation
app.get('/oauth', (req, res) => {
  const shop = req.query.shop;
  
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  console.log('OAuth redirect for shop:', shop);

  const scope = 'read_products,write_checkouts,read_orders,read_customers,write_marketing_events,write_discounts';
  const redirect_uri = `${HOST}/oauth/callback`;
  const state = Math.random().toString(36).substring(2, 15);
  
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${scope}&redirect_uri=${redirect_uri}&state=${state}`;
  
  res.redirect(authUrl);
});

// OAuth callback
app.get('/oauth/callback', async (req, res) => {
  const { code, shop, state } = req.query;

  if (!code || !shop) {
    return res.status(400).send('Missing required parameters');
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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

    console.log('Access token received for shop:', shop);

    // Store in database
    if (pool) {
      try {
        console.log('Attempting to store shop data for:', shop);
        console.log('Access token received:', tokenData.access_token ? 'YES' : 'NO');
        
        // First check if shops table exists and what columns it has
        const tableCheck = await pool.query(`
          SELECT column_name, data_type 
          FROM information_schema.columns 
          WHERE table_name = 'shops'
        `);
        console.log('Shops table columns:', tableCheck.rows);
        
        const query = `
          INSERT INTO shops (shop, access_token, plan, settings, created_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (shop) 
          DO UPDATE SET 
            access_token = $2
          RETURNING *
        `;
        
        const values = [
          shop,
          tokenData.access_token,
          'free', // default plan
          JSON.stringify({}) // default empty settings
        ];

        console.log('Executing query with values:', values[0], values[2]); // Don't log the access token
        const result = await pool.query(query, values);
        console.log('Shop data stored successfully:', result.rows[0]);
        
      } catch (dbError) {
        console.error('Database storage failed:', dbError);
        console.error('Error details:', {
          message: dbError.message,
          code: dbError.code,
          detail: dbError.detail,
          hint: dbError.hint
        });
        // Continue anyway - we have the token
      }
    } else {
      console.error('Database storage failed: No database connection');
    }

    // Success response
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>TheCartSave - Installation Complete</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; margin-top: 100px; }
          .success { color: #28a745; font-size: 24px; margin-bottom: 20px; }
          .info { color: #6c757d; font-size: 16px; }
        </style>
      </head>
      <body>
        <div class="success">✅ TheCartSave installed successfully!</div>
        <div class="info">
          <p>Shop: <strong>${shop}</strong></p>
          <p>You can now close this window and return to your Shopify admin.</p>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send('Installation failed: ' + error.message);
  }
});

// Webhook endpoint (placeholder for future)
app.post('/webhook/carts/update', (req, res) => {
  console.log('Cart update webhook received');
  res.status(200).send('OK');
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).send('Internal Server Error');
});

// 404 handler
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// Start server
app.listen(PORT, () => {
  console.log(`TheCartSave server running on port ${PORT}`);
  console.log('Environment check:', {
    shopify_key: !!SHOPIFY_API_KEY,
    shopify_secret: !!SHOPIFY_API_SECRET,
    host: !!HOST,
    database_url: !!DATABASE_URL
  });
});

module.exports = app;
