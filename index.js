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
const HOST = process.env.HOST; // your Vercel app URL

// Step 1: OAuth entry
app.get('/oauth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop');
  const state = crypto.randomBytes(16).toString('hex');
  const redirect = `https://${shop}/admin/oauth/authorize?client_id=${API_KEY}&scope=read_products,write_checkouts,read_orders,read_customers,write_marketing_events,write_discounts&state=${state}&redirect_uri=${HOST}/oauth/callback`;
  res.redirect(redirect);
});

// Step 2: OAuth callback
app.get('/oauth/callback', async (req, res) => {
  const { shop, code } = req.query;
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: API_KEY, client_secret: API_SECRET, code })
  });
  const tokenJson = await tokenRes.json();
  const accessToken = tokenJson.access_token;

  await pool.query(
    `INSERT INTO shops (shop, access_token) VALUES ($1,$2) ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token`,
    [shop, accessToken]
  );

  res.send("App installed! ✅ You can close this tab.");
});

// Step 3: Webhook endpoint
app.post('/webhooks/checkout_update', async (req, res) => {
  const payload = req.body;
  // You’ll later send this payload to n8n
  console.log("Checkout update:", payload);
  res.status(200).send("ok");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
