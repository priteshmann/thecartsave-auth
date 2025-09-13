// Force production domain
app.use((req, res, next) => {
  const host = req.headers.host;
  if (host !== 'thecartsave-auth.vercel.app') {
    const redirectUrl = `https://thecartsave-auth.vercel.app${req.originalUrl}`;
    console.log("[DEBUG] Forcing host redirect to production:", redirectUrl);
    return res.redirect(301, redirectUrl);
  }
  next();
});

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const API_KEY = process.env.SHOPIFY_API_KEY;
const API_SECRET = process.env.SHOPIFY_API_SECRET;
const HOST = process.env.HOST; // must be set to https://thecartsave-auth.vercel.app

// Root route - helpful redirect
app.get('/', (req, res) => {
  const shop = req.query.shop || 'thecartsave-dev.myshopify.com';
  console.log("[DEBUG] Root accessed, redirecting to /oauth with shop =", shop);
  return res.redirect(`/oauth?shop=${encodeURIComponent(shop)}`);
});

// Step 1: OAuth entry
app.get('/oauth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop');

  const state = crypto.randomBytes(16).toString('hex');

  const redirect = `https://${shop}/admin/oauth/authorize?client_id=${API_KEY}` +
    `&scope=read_products,write_checkouts,read_orders,read_customers,write_marketing_events,write_discounts` +
    `&state=${state}` +
    `&redirect_uri=${HOST}/oauth/callback`;

  console.log("[DEBUG] Install redirect URL:", redirect);

  res.redirect(redirect);
});

// Step 2: OAuth callback
app.get('/oauth/callback', async (req, res) => {
  try {
    const { shop, code } = req.query;
    if (!shop || !code) {
      console.error("[ERROR] Missing shop or code in callback:", req.query);
      return res.status(400).send("Missing required params");
    }

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
      return res.status(400).send("Failed to get access token");
    }

    await pool.query(
      `INSERT INTO shops (shop, access_token) VALUES ($1,$2) 
       ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token`,
      [shop, accessToken]
    );

    res.send("App installed! ✅ You can close this tab.");
  } catch (err) {
    console.error("[ERROR] OAuth callback failed:", err);
    res.status(500).send("OAuth callback error");
  }
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

// Start server (for local dev only, Vercel handles prod)
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));

