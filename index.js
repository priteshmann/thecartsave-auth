require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const crypto = require('crypto');
const cookieSession = require('cookie-session');

const app = express();

// IMPORTANT for secure cookies on Vercel
app.set('trust proxy', 1);

// body parser
app.use(express.json());

// Secure cookie session for OAuth state
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SHOPIFY_API_SECRET || 'fallback-secret'],
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
  secure: true,    // only send cookie over HTTPS
  httpOnly: true,
  sameSite: 'lax'
}));

// Force all requests to production domain
app.use((req, res, next) => {
  const host = req.headers.host || '';
  const expectedHost = 'thecartsave-auth.vercel.app';

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

// Log env presence (don’t exit in Vercel, just warn)
if (!API_KEY || !API_SECRET || !HOST) {
  console.error('[ERROR] Missing required environment variables. Check SHOPIFY_API_KEY, SHOPIFY_API_SECRET, HOST.');
}

// Root route
app.get('/', (req, res) => {
  const shop = req.query.shop || 'thecartsave-dev.myshopify.com';
  console.log("[DEBUG] Root accessed, redirecting to /oauth with shop =", shop);
  return res.redirect(`/oauth?shop=${encodeURIComponent(shop)}`);
});

// Step 1: OAuth entry
app.get('/oauth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  if (!shop.includes('.myshopify.com')) return res.status(400).send('Invalid shop domain');

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

  const redirectUri = `${HOST}/oauth/callback`;

  const authUrl = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${API_KEY}` +
    `&scope=${scopes}` +
    `&state=${state}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  console.log("[DEBUG] Install redirect URL:", authUrl);
  console.log("[DEBUG] Redirect URI being used:", redirectUri);
  console.log("[DEBUG] HOST env var:", HOST);

  res.redirect(authUrl);
});

// Step 2: OAuth callback
app.get('/oauth/callback', async (req, res) => {
  try {
    const { shop, code, state } = req.query;

    if (!shop || !code) {
      console.error("[ERROR] Missing shop or code in callback:", req.query);
      return res.status(400).send("Missing required params");
    }

    if (!state || state !== req.session.oauthState) {
      console.error("[ERROR] Invalid state parameter");
      return res.status(400).send("Invalid state parameter");
    }

    if (shop !== req.session.shop) {
      console.error("[ERROR] Shop mismatch");
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

    await pool.query(
      `INSERT INTO shops (shop, access_token) VALUES ($1,$2) 
       ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token`,
      [shop, accessToken]
    );

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
    res.status(200).send("ok");
  } catch (err) {
    console.error("[ERROR] Webhook error:", err);
    res.status(500).send("Webhook error");
  }
});

// Export for Vercel
module.exports = app;

// Start server (local dev only)
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("Server running on port", port));
}
