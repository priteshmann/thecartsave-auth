const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Get environment variables
const API_KEY = process.env.SHOPIFY_API_KEY;
const API_SECRET = process.env.SHOPIFY_API_SECRET;
const HOST = process.env.HOST || 'https://thecartsave-auth.vercel.app';

// Database setup
let pool = null;
if (process.env.DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    console.log('Database connection pool initialized');
  } catch (error) {
    console.error('Failed to initialize database pool:', error.message);
  }
}

// In-memory session store (simple for now)
const sessions = new Map();

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env_check: {
      SHOPIFY_API_KEY: API_KEY ? 'present' : 'missing',
      SHOPIFY_API_SECRET: API_SECRET ? 'present' : 'missing',
      HOST: HOST,
      DATABASE_URL: process.env.DATABASE_URL ? 'present' : 'missing'
    }
  });
});

// Root route
app.get('/', (req, res) => {
  const shop = req.query.shop || 'thecartsave-dev.myshopify.com';
  console.log("Root accessed, redirecting to /oauth with shop =", shop);
  return res.redirect(`/oauth?shop=${encodeURIComponent(shop)}`);
});

// Debug endpoint
app.get('/debug', (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    environment: {
      API_KEY: API_KEY ? `${API_KEY.substring(0, 8)}...` : 'MISSING',
      API_SECRET: API_SECRET ? 'Present' : 'MISSING',
      HOST: HOST,
      DATABASE_URL: process.env.DATABASE_URL ? 'Present' : 'MISSING',
      NODE_ENV: process.env.NODE_ENV || 'not set'
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
    }
  });
});

// OAuth entry point
app.get('/oauth', (req, res) => {
  const shop = req.query.shop;
  const debug = req.query.debug;
  
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }
  
  if (!API_KEY) {
    return res.status(500).send('SHOPIFY_API_KEY not configured');
  }
  
  if (!shop.includes('.myshopify.com')) {
    return res.status(400).send('Invalid shop domain');
  }
  
  // Generate and store state (in memory for now)
  const state = crypto.randomBytes(16).toString('hex');
  const sessionId = crypto.randomBytes(16).toString('hex');
  
  sessions.set(sessionId, {
    oauthState: state,
    shop: shop,
    createdAt: Date.now()
  });
  
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
  
  console.log("OAuth redirect for shop:", shop);
  
  // Debug mode shows options
  if (debug === '1') {
    return res.send(`
      <html>
        <head><title>OAuth Debug</title></head>
        <body style="font-family: monospace; padding: 20px; line-height: 1.6;">
          <h2>OAuth Debug Information</h2>
          <p><strong>Shop:</strong> ${shop}</p>
          <p><strong>HOST:</strong> ${HOST}</p>
          <p><strong>Redirect URI:</strong> ${redirectUri}</p>
          <p><strong>API Key:</strong> ${API_KEY ? `${API_KEY.substring(0, 8)}...` : 'MISSING'}</p>
          <p><strong>Session ID:</strong> ${sessionId}</p>
          <p><strong>State:</strong> ${state}</p>
          
          <h3>Partner Dashboard Should Have:</h3>
          <p><strong>App URL:</strong> ${HOST}</p>
          <p><strong>Allowed redirection URL(s):</strong> ${redirectUri}</p>
          
          <div style="margin: 20px 0; padding: 15px; background: #f0f0f0;">
            <h4>OAuth URL:</h4>
            <textarea style="width: 100%; height: 80px; margin-bottom: 10px;">${authUrl}</textarea>
            <a href="${authUrl}" style="background: #5cb85c; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px;">Install App</a>
          </div>
        </body>
      </html>
    `);
  }
  
  // Set session cookie and redirect
  res.setHeader('Set-Cookie', `session=${sessionId}; Path=/; HttpOnly; Max-Age=3600`);
  res.redirect(authUrl);
});

// OAuth callback
app.get('/oauth/callback', async (req, res) => {
  try {
    const { shop, code, state, error } = req.query;
    
    console.log("OAuth callback received:", { shop, code: !!code, state, error });
    
    if (error) {
      return res.status(400).send(`OAuth error: ${error}`);
    }
    
    if (!shop || !code) {
      return res.status(400).send("Missing shop or code parameters");
    }
    
    if (!API_KEY || !API_SECRET) {
      return res.status(500).send('Shopify credentials not configured');
    }
    
    // Find session by state (simple approach)
    let sessionData = null;
    for (const [sessionId, data] of sessions) {
      if (data.oauthState === state && data.shop === shop) {
        sessionData = data;
        sessions.delete(sessionId); // Clean up
        break;
      }
    }
    
    if (!sessionData) {
      return res.status(400).send("Invalid or expired session");
    }
    
    console.log("Exchanging code for access token...");
    
    // Exchange code for access token
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
      console.error("Token exchange failed:", tokenJson);
      return res.status(400).send("Failed to get access token");
    }
    
    console.log("Access token received for shop:", shop);
    
    // Store in database
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO shops (shop, access_token) VALUES ($1, $2) 
           ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token`,
          [shop, accessToken]
        );
        console.log("Access token stored in database for shop:", shop);
      } catch (dbError) {
        console.error("Database storage failed:", dbError.message);
        // Continue anyway - don't fail the OAuth flow
      }
    } else {
      console.log("No database configured - token not stored");
    }
    
    res.send(`
      <html>
        <head><title>Installation Complete</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>🎉 App Installed Successfully!</h1>
          <p>TheCartSave has been installed for <strong>${shop}</strong></p>
          <p>Access token received and ${pool ? 'stored in database' : 'logged (database not configured)'}!</p>
          <p>You can now close this tab.</p>
          
          <div style="margin-top: 30px; padding: 20px; background: #f0f0f0; border-radius: 8px;">
            <h3>Installation Complete</h3>
            <p>Your Shopify app is now ready to use!</p>
            ${pool ? '<p>✅ Database connection: Working</p>' : '<p>⚠️ Database connection: Not configured</p>'}
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("OAuth callback error: " + err.message);
  }
});

// Webhook endpoint
app.post('/webhooks/checkout_update', (req, res) => {
  console.log("Checkout update webhook received");
  res.status(200).send("ok");
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Host: ${HOST}`);
  console.log(`Database configured: ${!!process.env.DATABASE_URL}`);
});

module.exports = app;
