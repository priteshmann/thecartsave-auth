require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const crypto = require('crypto');
const cookieSession = require('cookie-session');

const app = express();
app.use(express.json());

// Add cookie session for state management
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SHOPIFY_API_SECRET], // Use your secret as key
  maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));

// IMPORTANT: Force redirect to production domain
app.use((req, res, next) => {
  const host = req.headers.host || '';
  const expectedHost = 'thecartsave-auth.vercel.app';
  
  // If we're not on the production domain, redirect
  if (host !== expectedHost && !host.includes('localhost')) {
    const redirectUrl = `https://${expectedHost}${req.originalUrl}`;
    console.log(`[REDIRECT] Forcing redirect from ${host} to ${expectedHost}`);
    return res.redirect(301, redirectUrl);
  }
  
  console.log(`[HOST-DBG] host=${host} path=${req.originalUrl || req.url}`);
  next();
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const API_KEY = process.env.SHOPIFY_API_KEY;
const API_SECRET = process.env.SHOPIFY_API_SECRET;
const HOST = process.env.HOST; // should be https://thecartsave-auth.vercel.app

// Validate required environment variables
if (!API_KEY || !API_SECRET || !HOST) {
  console.error('[ERROR] Missing required environment variables');
  process.exit(1);
}

// Root route
app.get('/', (req, res) => {
  const shop = req.query.shop || 'thecartsave-dev.myshopify.com';
  console.log("[DEBUG] Root accessed, redirecting to /oauth with shop =", shop);
  return res.redirect(`/oauth?shop=${encodeURIComponent(shop)}`);
});

// DEBUGGING ROUTE - Check what Shopify Partner Dashboard should have
app.get('/debug', (req, res) => {
  const debugInfo = {
    environment: {
      API_KEY: API_KEY ? `${API_KEY.substring(0, 8)}...` : 'MISSING',
      API_SECRET: API_SECRET ? 'Present' : 'MISSING',
      HOST: HOST,
      NODE_ENV: process.env.NODE_ENV
    },
    shopifyPartnerDashboard: {
      appUrl: HOST,
      allowedRedirectionUrl: `${HOST}/oauth/callback`,
      note: 'These values should EXACTLY match your Shopify Partner Dashboard settings'
    },
    testUrls: {
      installUrl: `${HOST}/oauth?shop=thecartsave-dev.myshopify.com`,
      callbackUrl: `${HOST}/oauth/callback`
    }
  };
  
  res.json(debugInfo);
});

// Step 1: OAuth entry
app.get('/oauth', (req, res) => {
  const shop = req.query.shop;
  
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
  
  // CRITICAL: Make sure redirect_uri exactly matches Partner Dashboard
  const redirectUri = `${HOST}/oauth/callback`;
  
  const authUrl = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${API_KEY}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${state}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  // DETAILED DEBUG LOGGING
  console.log("=== OAUTH DEBUG INFO ===");
  console.log("[DEBUG] Shop:", shop);
  console.log("[DEBUG] API_KEY:", API_KEY ? `${API_KEY.substring(0, 8)}...` : 'MISSING');
  console.log("[DEBUG] HOST env var:", HOST);
  console.log("[DEBUG] Redirect URI being sent:", redirectUri);
  console.log("[DEBUG] Full auth URL:", authUrl);
  console.log("[DEBUG] Request headers:", JSON.stringify(req.headers, null, 2));
  console.log("========================");
  
  // Instead of redirecting immediately, show debug info first
  res.send(`
    <html>
      <head><title>OAuth Debug</title></head>
      <body style="font-family: monospace; padding: 20px;">
        <h2>OAuth Debug Information</h2>
        <p><strong>Shop:</strong> ${shop}</p>
        <p><strong>HOST env var:</strong> ${HOST}</p>
        <p><strong>Redirect URI:</strong> ${redirectUri}</p>
        <p><strong>Current request host:</strong> ${req.headers.host}</p>
        
        <h3>Shopify Partner Dashboard Should Have:</h3>
        <p><strong>App URL:</strong> ${HOST}</p>
        <p><strong>Allowed redirection URL(s):</strong> ${redirectUri}</p>
        
        <h3>Generated Auth URL:</h3>
        <textarea style="width: 100%; height: 100px;">${authUrl}</textarea>
        
        <br><br>
        <a href="${authUrl}" style="background: #5cb85c; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
          Continue to Shopify OAuth
        </a>
        
        <br><br>
        <p><em>Check the console logs for more detailed information</em></p>
      </body>
    </html>
  `);
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
    
    // Store in database
    await pool.query(
      `INSERT INTO shops (shop, access_token) VALUES ($1,$2) 
       ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token`,
      [shop, accessToken]
    );
    
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
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    host: req.headers.host,
    env: {
      hasApiKey: !!API_KEY,
      hasSecret: !!API_SECRET,
      host: HOST
    }
  });
});

// Step 3: Webhook endpoint
app.post('/webhooks/checkout_update', async (req, res) => {
  try {
    const payload = req.body;
    console.log("Checkout update webhook received:", payload);
    // Later: forward to n8n
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
