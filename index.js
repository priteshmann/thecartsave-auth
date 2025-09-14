const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const crypto = require('crypto');
const cookieSession = require('cookie-session');

const app = express();
app.use(express.json());

// Basic health check first - this should work without database
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: {
      hasApiKey: !!process.env.SHOPIFY_API_KEY,
      hasSecret: !!process.env.SHOPIFY_API_SECRET,
      hasHost: !!process.env.HOST,
      hasDatabase: !!process.env.DATABASE_URL
    }
  });
});

// Get environment variables with defaults
const API_KEY = process.env.SHOPIFY_API_KEY;
const API_SECRET = process.env.SHOPIFY_API_SECRET;
const HOST = process.env.HOST || 'https://thecartsave-auth.vercel.app';

// Only initialize database if DATABASE_URL exists
let pool = null;
if (process.env.DATABASE_URL) {
  try {
    pool = new Pool({ 
      connectionString: process.env.DATABASE_URL
    });
    console.log('[INFO] Database pool created');
    
    // Create table asynchronously (don't block startup)
    pool.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id SERIAL PRIMARY KEY,
        shop VARCHAR(255) UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(err => console.log('[WARNING] Table creation error:', err.message));
    
  } catch (err) {
    console.error('[ERROR] Database pool creation failed:', err.message);
  }
} else {
  console.log('[WARNING] DATABASE_URL not found, database features disabled');
}

// Add cookie session only if we have API_SECRET
if (API_SECRET) {
  app.use(cookieSession({
    name: 'session',
    keys: [API_SECRET], 
    maxAge: 24 * 60 * 60 * 1000 
  }));
}

// Simple logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Root route
app.get('/', (req, res) => {
  const shop = req.query.shop || 'thecartsave-dev.myshopify.com';
  console.log("[DEBUG] Root accessed, redirecting to /oauth with shop =", shop);
  return res.redirect(`/oauth?shop=${encodeURIComponent(shop)}`);
});

// Debug endpoint
app.get('/debug', (req, res) => {
  const debugInfo = {
    timestamp: new Date().toISOString(),
    environment: {
      API_KEY: API_KEY ? `${API_KEY.substring(0, 8)}...` : 'MISSING',
      API_SECRET: API_SECRET ? 'Present' : 'MISSING',
      HOST: HOST,
      DATABASE_URL: process.env.DATABASE_URL ? 'Present' : 'MISSING',
      NODE_ENV: process.env.NODE_ENV || 'not set'
    },
    status: 'Server is running'
  };
  
  res.json(debugInfo);
});

// OAuth entry point
app.get('/oauth', (req, res) => {
  const shop = req.query.shop;
  
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }
  
  if (!API_KEY) {
    return res.status(500).send('SHOPIFY_API_KEY not configured');
  }
  
  // Validate shop domain format
  if (!shop.includes('.myshopify.com')) {
    return res.status(400).send('Invalid shop domain');
  }
  
  // Generate and store state
  const state = crypto.randomBytes(16).toString('hex');
  if (req.session) {
    req.session.oauthState = state;
    req.session.shop = shop;
  }
  
  const scopes = [
    'read_products',
    'write_checkouts', 
    'read_orders',
    'read_customers',
    'write_marketing_events',
    'write_discounts'
  ].join(',');
  
  const redirectUri = `${HOST}/oauth/callback`;
  const authUrl = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${API_KEY}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${state}` +
    `&redirect_uri=${redirectUri}`;
  
  console.log("[DEBUG] Redirecting to:", authUrl);
  res.redirect(authUrl);
});

// OAuth callback
app.get('/oauth/callback', async (req, res) => {
  try {
    const { shop, code, state, error } = req.query;
    
    if (error) {
      console.error("[ERROR] OAuth error:", error);
      return res.status(400).send(`OAuth error: ${error}`);
    }
    
    if (!shop || !code) {
      console.error("[ERROR] Missing shop or code");
      return res.status(400).send("Missing required params");
    }
    
    if (!API_KEY || !API_SECRET) {
      return res.status(500).send('Shopify credentials not configured');
    }
    
    // Verify state if session exists
    if (req.session && req.session.oauthState && state !== req.session.oauthState) {
      console.error("[ERROR] Invalid state parameter");
      return res.status(400).send("Invalid state parameter");
    }
    
    console.log("[DEBUG] Exchanging code for token...");
    
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: API_KEY,
        client_secret: API_SECRET,
        code
      })
    });
    
    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson.access_token;
    
    if (!accessToken) {
      console.error("[ERROR] No access token received");
      return res.status(400).send("Failed to get access token");
    }
    
    // Store in database if available
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO shops (shop, access_token) VALUES ($1,$2) 
           ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token`,
          [shop, accessToken]
        );
        console.log("[SUCCESS] Token stored for shop:", shop);
      } catch (dbError) {
        console.error("[ERROR] Database error:", dbError.message);
        // Continue anyway - don't fail the OAuth flow
      }
    }
    
    // Clear session
    if (req.session) {
      req.session = null;
    }
    
    res.send(`
      <html>
        <head><title>Installation Complete</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>🎉 App Installed Successfully!</h1>
          <p>TheCartSave has been installed for <strong>${shop}</strong></p>
          <p>You can now close this tab.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("[ERROR] OAuth callback failed:", err);
    res.status(500).send("OAuth callback error: " + err.message);
  }
});

// Webhook endpoint
app.post('/webhooks/checkout_update', async (req, res) => {
  try {
    console.log("Checkout update webhook received");
    res.status(200).send("ok");
  } catch (err) {
    console.error("[ERROR] Webhook error:", err);
    res.status(500).send("Webhook error");
  }
});

// Export for Vercel
module.exports = app;
