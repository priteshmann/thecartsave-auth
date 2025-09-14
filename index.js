require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const crypto = require('crypto');
const cookieSession = require('cookie-session');

const app = express();
app.use(express.json());

// Validate required environment variables first
const API_KEY = process.env.SHOPIFY_API_KEY;
const API_SECRET = process.env.SHOPIFY_API_SECRET;
const HOST = process.env.HOST;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY) {
  console.error('[ERROR] SHOPIFY_API_KEY environment variable is missing');
  process.exit(1);
}

if (!API_SECRET) {
  console.error('[ERROR] SHOPIFY_API_SECRET environment variable is missing');
  process.exit(1);
}

if (!HOST) {
  console.error('[ERROR] HOST environment variable is missing');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('[ERROR] DATABASE_URL environment variable is missing');
  process.exit(1);
}

console.log('[INFO] All environment variables loaded successfully');
console.log('[INFO] API_KEY:', API_KEY ? `${API_KEY.substring(0, 8)}...` : 'MISSING');
console.log('[INFO] HOST:', HOST);
console.log('[INFO] DATABASE_URL:', DATABASE_URL ? `${DATABASE_URL.substring(0, 30)}...` : 'MISSING');

// Add cookie session for state management
app.use(cookieSession({
  name: 'session',
  keys: [API_SECRET], 
  maxAge: 24 * 60 * 60 * 1000 
}));

// IMPORTANT: Force redirect to production domain and log everything
app.use((req, res, next) => {
  const host = req.headers.host || '';
  const expectedHost = 'thecartsave-auth.vercel.app';
  
  console.log(`[REQUEST] ${req.method} ${req.originalUrl}`);
  console.log(`[HEADERS] Host: ${host}, User-Agent: ${req.headers['user-agent']}`);
  console.log(`[QUERY] ${JSON.stringify(req.query)}`);
  
  // If we're not on the production domain, redirect
  if (host !== expectedHost && !host.includes('localhost')) {
    const redirectUrl = `https://${expectedHost}${req.originalUrl}`;
    console.log(`[REDIRECT] Forcing redirect from ${host} to ${expectedHost}`);
    return res.redirect(301, redirectUrl);
  }
  
  next();
});

// Initialize database connection with error handling
let pool;
try {
  pool = new Pool({ 
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : false
  });
  console.log('[INFO] Database pool created successfully');
} catch (err) {
  console.error('[ERROR] Failed to create database pool:', err.message);
  process.exit(1);
}

// Test database connection
pool.connect()
  .then(client => {
    console.log('[INFO] Database connected successfully');
    client.release();
  })
  .catch(err => {
    console.error('[ERROR] Database connection failed:', err.message);
  });

// Create table if it doesn't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS shops (
    id SERIAL PRIMARY KEY,
    shop VARCHAR(255) UNIQUE NOT NULL,
    access_token TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).then(() => {
  console.log('[INFO] Database table ready');
}).catch(err => {
  console.log('[WARNING] Table creation error (might already exist):', err.message);
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
      DATABASE_URL: DATABASE_URL ? 'Present' : 'MISSING',
      NODE_ENV: process.env.NODE_ENV
    },
    shopifyPartnerDashboard: {
      appUrl: HOST,
      allowedRedirectionUrl: `${HOST}/oauth/callback`,
      note: 'These values should EXACTLY match your Shopify Partner Dashboard settings'
    },
    testUrls: {
      installUrl: `${HOST}/oauth?shop=thecartsave-dev.myshopify.com`,
      callbackUrl: `${HOST}/oauth/callback`,
      debugInstallUrl: `${HOST}/oauth?shop=thecartsave-dev.myshopify.com&debug=1`
    },
    troubleshooting: {
      "Step 1": "Verify Partner Dashboard settings match exactly",
      "Step 2": "Try creating a new development store",
      "Step 3": "Try creating a new app in Partner Dashboard",
      "Step 4": "Use Partner Dashboard 'Test on development store' button",
      "Step 5": "Check if app is Public (not Custom)"
    }
  };
  
  res.json(debugInfo);
});

// Step 1: OAuth entry with multiple fallback approaches
app.get('/oauth', (req, res) => {
  const shop = req.query.shop;
  const debug = req.query.debug;
  
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }
  
  // Validate shop domain format
  if (!shop.includes('.myshopify.com')) {
    return res.status(400).send('Invalid shop domain');
  }
  
  // Generate and store state
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.shop = shop;
  
  const scopes = [
    'read_products',
    'write_checkouts', 
    'read_orders',
    'read_customers',
    'write_marketing_events',
    'write_discounts'
  ].join(',');
  
  // CRITICAL: Try different approaches based on common solutions
  const redirectUri = `${HOST}/oauth/callback`;
  
  // Try approach 1: Standard OAuth URL
  const authUrl1 = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${API_KEY}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${state}` +
    `&redirect_uri=${redirectUri}`;
  
  // Try approach 2: Without encoding scopes
  const authUrl2 = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${API_KEY}` +
    `&scope=${scopes}` +
    `&state=${state}` +
    `&redirect_uri=${redirectUri}`;
  
  // Try approach 3: With encoded redirect_uri
  const authUrl3 = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${API_KEY}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${state}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  console.log("=== OAUTH DEBUG INFO ===");
  console.log("[DEBUG] Shop:", shop);
  console.log("[DEBUG] API_KEY:", API_KEY ? `${API_KEY.substring(0, 8)}...` : 'MISSING');
  console.log("[DEBUG] HOST env var:", HOST);
  console.log("[DEBUG] Redirect URI:", redirectUri);
  console.log("[DEBUG] Auth URL 1 (standard):", authUrl1);
  console.log("[DEBUG] Auth URL 2 (no scope encoding):", authUrl2);
  console.log("[DEBUG] Auth URL 3 (full encoding):", authUrl3);
  console.log("[DEBUG] Request headers:", JSON.stringify(req.headers, null, 2));
  console.log("========================");
  
  // If debug mode, show all options
  if (debug === '1') {
    return res.send(`
      <html>
        <head><title>OAuth Debug</title></head>
        <body style="font-family: monospace; padding: 20px; line-height: 1.6;">
          <h2>OAuth Debug Information</h2>
          <p><strong>Shop:</strong> ${shop}</p>
          <p><strong>HOST env var:</strong> ${HOST}</p>
          <p><strong>Redirect URI:</strong> ${redirectUri}</p>
          <p><strong>Current request host:</strong> ${req.headers.host}</p>
          <p><strong>API Key:</strong> ${API_KEY ? `${API_KEY.substring(0, 8)}...` : 'MISSING'}</p>
          
          <h3>Partner Dashboard Should Have:</h3>
          <p><strong>App URL:</strong> ${HOST}</p>
          <p><strong>Allowed redirection URL(s):</strong> ${redirectUri}</p>
          <p><strong>App Type:</strong> Public (NOT Custom)</p>
          
          <h3>Try These OAuth URLs:</h3>
          
          <div style="margin: 20px 0; padding: 15px; background: #f0f0f0;">
            <h4>Option 1: Standard (recommended)</h4>
            <textarea style="width: 100%; height: 80px; margin-bottom: 10px;">${authUrl1}</textarea>
            <a href="${authUrl1}" style="background: #5cb85c; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px;">Try Option 1</a>
          </div>
          
          <div style="margin: 20px 0; padding: 15px; background: #f0f0f0;">
            <h4>Option 2: No scope encoding</h4>
            <textarea style="width: 100%; height: 80px; margin-bottom: 10px;">${authUrl2}</textarea>
            <a href="${authUrl2}" style="background: #f0ad4e; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px;">Try Option 2</a>
          </div>
          
          <div style="margin: 20px 0; padding: 15px; background: #f0f0f0;">
            <h4>Option 3: Full encoding</h4>
            <textarea style="width: 100%; height: 80px; margin-bottom: 10px;">${authUrl3}</textarea>
            <a href="${authUrl3}" style="background: #5bc0de; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px;">Try Option 3</a>
          </div>
          
          <h3>Troubleshooting Steps:</h3>
          <ol>
            <li>Verify your Partner Dashboard settings match exactly</li>
            <li>Make sure your app is <strong>Public</strong>, not Custom</li>
            <li>Try creating a new development store</li>
            <li>Try the Partner Dashboard "Test on development store" button</li>
            <li>Clear browser cache and try incognito mode</li>
          </ol>
        </body>
      </html>
    `);
  }
  
  // Normal flow - use the standard approach
  res.redirect(authUrl1);
});

// Step 2: OAuth callback
app.get('/oauth/callback', async (req, res) => {
  try {
    console.log("=== OAUTH CALLBACK DEBUG ===");
    console.log("[DEBUG] Callback query params:", req.query);
    console.log("[DEBUG] Session data:", req.session);
    console.log("[DEBUG] Request headers:", JSON.stringify(req.headers, null, 2));
    console.log("============================");
    
    const { shop, code, state, error } = req.query;
    
    if (error) {
      console.error("[ERROR] OAuth error from Shopify:", error);
      return res.status(400).send(`OAuth error from Shopify: ${error}`);
    }
    
    if (!shop || !code) {
      console.error("[ERROR] Missing shop or code in callback:", req.query);
      return res.status(400).send("Missing required params");
    }
    
    // Verify state parameter
    if (!state || state !== req.session.oauthState) {
      console.error("[ERROR] Invalid state parameter. Expected:", req.session.oauthState, "Got:", state);
      return res.status(400).send("Invalid state parameter");
    }
    
    // Verify shop matches
    if (shop !== req.session.shop) {
      console.error("[ERROR] Shop mismatch. Expected:", req.session.shop, "Got:", shop);
      return res.status(400).send("Shop mismatch");
    }
    
    console.log("[DEBUG] Exchanging code for access token...");
    
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
    console.log("[DEBUG] Token exchange response:", tokenJson);
    
    const accessToken = tokenJson.access_token;
    if (!accessToken) {
      console.error("[ERROR] No access token in response:", tokenJson);
      return res.status(400).send("Failed to get access token");
    }
    
    // Store in database with error handling
    try {
      await pool.query(
        `INSERT INTO shops (shop, access_token) VALUES ($1,$2) 
         ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token`,
        [shop, accessToken]
      );
      console.log("[SUCCESS] Token stored in database for shop:", shop);
    } catch (dbError) {
      console.error("[ERROR] Database error:", dbError.message);
      return res.status(500).send("Database error occurred");
    }
    
    // Clear session
    req.session = null;
    
    console.log("[SUCCESS] App installed successfully for shop:", shop);
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

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    const dbResult = await pool.query('SELECT NOW()');
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      host: req.headers.host,
      database: 'connected',
      dbTime: dbResult.rows[0].now,
      env: {
        hasApiKey: !!API_KEY,
        hasSecret: !!API_SECRET,
        host: HOST,
        hasDatabase: !!DATABASE_URL
      }
    });
  } catch (err) {
    console.error('[ERROR] Health check failed:', err.message);
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      host: req.headers.host,
      database: 'disconnected',
      error: err.message,
      env: {
        hasApiKey: !!API_KEY,
        hasSecret: !!API_SECRET,
        host: HOST,
        hasDatabase: !!DATABASE_URL
      }
    });
  }
});

// Webhook endpoint
app.post('/webhooks/checkout_update', async (req, res) => {
  try {
    const payload = req.body;
    console.log("Checkout update webhook received:", payload);
    res.status(200).send("ok");
  } catch (err) {
    console.error("[ERROR] Webhook error:", err);
    res.status(500).send("Webhook error");
  }
});

// Export for Vercel
module.exports = app;

// Start server (local dev only; Vercel handles prod)
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("Server running on port", port));
}
