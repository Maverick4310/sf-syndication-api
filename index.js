import express from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const SF_INSTANCE_URL = process.env.SF_INSTANCE_URL;
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_PASSWORD = process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN;
const CONFIRM_URL = process.env.CONFIRM_URL || `${SF_INSTANCE_URL}/apex/SyndicationConfirm`;

// Keywords (env override possible)
const DEFAULT_KEYWORDS = [
  // apply variations
  "apply", "apply now", "application", "apply online", "apply today",
  // credit variations
  "credit", "credit app", "credit application", "credit approval", "get credit",
  // finance/financing variations
  "finance", "financing", "financing options", "finance application",
  "finance request", "financing program", "get financed",
  // loan / pre-approval variations
  "loan", "loan application", "get approved", "pre-approve", "pre-approval",
  // quote variations
  "quote", "get a quote", "request a quote",
  // e-commerce variations
  "shop", "shopping", "add to cart", "checkout", "buy now"
];
const KEYWORDS = process.env.CREDIT_KEYWORDS
  ? process.env.CREDIT_KEYWORDS.split(',').map(k => k.trim().toLowerCase())
  : DEFAULT_KEYWORDS.map(k => k.toLowerCase());

// Candidate link triggers (for crawling beyond homepage)
const LINK_TRIGGERS = [
  "finance", "credit", "apply", "loan", "inventory",
  "equipment", "machinery", "trucks", "products", "quote",
  "shop", "cart", "checkout", "buy"
];

let accessToken = null;

// --------------------------------------------------
// Helper: Normalize and Resolve URL with Fallbacks
// --------------------------------------------------
async function resolveUrl(rawUrl) {
  if (!rawUrl) return null;
  let input = rawUrl.trim();

  // Already has protocol? return directly
  if (input.startsWith("http://") || input.startsWith("https://")) {
    return input;
  }

  const attempts = [];

  // If no protocol → try https first
  attempts.push("https://" + input);
  attempts.push("http://" + input);

  // If no 'www.' in original → also try with www
  if (!input.startsWith("www.")) {
    attempts.push("https://www." + input);
    attempts.push("http://www." + input);
  }

  // Try each URL until one responds
  for (let url of attempts) {
    try {
      const resp = await fetch(url, { method: "HEAD", redirect: "follow", timeout: 5000 });
      if (resp.status >= 200 && resp.status < 400) {
        return resp.url; // ✅ capture final resolved URL after redirects
      }
    } catch (err) {
      // continue to next attempt
    }
  }

  // If all attempts fail, default to https:// + input
  return "https://" + input;
}

// --------------------------------------------------
// Helper: Authenticate with Salesforce
// --------------------------------------------------
async function getAccessToken() {
  const res = await fetch(`${SF_INSTANCE_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
      username: SF_USERNAME,
      password: SF_PASSWORD
    })
  });

  if (!res.ok) throw new Error(`Auth failed: ${await res.text()}`);
  const data = await res.json();
  accessToken = data.access_token;
  return accessToken;
}

// --------------------------------------------------
// Helper: Scan a single page for keywords
// --------------------------------------------------
async function scanPage(url) {
  try {
    const response = await fetch(url, { timeout: 15000 });
    const html = await response.text();
    const text = html.toLowerCase();
    let matchedKeywords = [];

    // Check body text
    KEYWORDS.forEach((kw) => {
      if (text.includes(kw)) matchedKeywords.push(kw);
    });

    // Check links/buttons
    const $ = cheerio.load(html);
    $('a, button').each((_, el) => {
      const txt = $(el).text().toLowerCase();
      const href = ($(el).attr('href') || '').toLowerCase();
      KEYWORDS.forEach((kw) => {
        if (txt.includes(kw) || href.includes(kw)) matchedKeywords.push(kw);
      });
    });

    return {
      url,
      hasCreditApp: matchedKeywords.length > 0,
      matchedKeywords: [...new Set(matchedKeywords)]
    };
  } catch (err) {
    return { url, error: err.message, hasCreditApp: false, matchedKeywords: [] };
  }
}

// --------------------------------------------------
// Route: Sync an Opportunity (existing)
// --------------------------------------------------
app.get('/sync/:oppId', async (req, res) => {
  const oppId = req.params.oppId;
  try {
    if (!oppId) return res.status(400).json({ status: 'FAIL', message: 'Missing Opportunity Id' });
    if (!accessToken) await getAccessToken();

    let sfResponse = await fetch(`${SF_INSTANCE_URL}/services/apexrest/syndication/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, oppid: oppId }
    });

    if (sfResponse.status === 401) {
      await getAccessToken();
      sfResponse = await fetch(`${SF_INSTANCE_URL}/services/apexrest/syndication/request`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, oppid: oppId }
      });
    }

    const data = await sfResponse.json();
    const msg = data.status === 'SUCCESS' ? 'Status Updated Successfully' : `Error: ${data.message}`;
    if (req.headers['accept']?.includes('application/json')) {
      res.json({ status: data.status, message: msg });
    } else {
      res.redirect(`${CONFIRM_URL}?message=${encodeURIComponent(msg)}`);
    }
  } catch (err) {
    if (req.headers['accept']?.includes('application/json')) {
      res.status(500).json({ status: 'FAIL', message: err.message });
    } else {
      res.redirect(`${CONFIRM_URL}?message=${encodeURIComponent('Exception: ' + err.message)}`);
    }
  }
});

// --------------------------------------------------
// Route: Dealer Credit/Financing Application Checker
// --------------------------------------------------
app.get('/dealer/check', async (req, res) => {
  const inputUrl = req.query.url;
  let resolvedUrl = await resolveUrl(inputUrl);
  if (!resolvedUrl) return res.status(400).json({ error: 'Missing ?url parameter' });

  try {
    // 🔹 Step 0: Check if site is active
    let siteActive = false;
    let statusCode = null;
    try {
      const headResp = await fetch(resolvedUrl, { method: 'HEAD', redirect: "follow", timeout: 5000 });
      statusCode = headResp.status;
      siteActive = statusCode >= 200 && statusCode < 400;
      resolvedUrl = headResp.url; // update with final redirect
    } catch (err) {
      siteActive = false;
    }

    const results = [];

    // Step 1: Scan homepage
    const homepageResult = await scanPage(resolvedUrl);
    results.push(homepageResult);

    // Step 2: Collect candidate links from homepage
    if (!homepageResult.error) {
      const response = await fetch(resolvedUrl, { timeout: 15000 });
      const html = await response.text();
      const $ = cheerio.load(html);

      const candidateLinks = [];
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const txt = $(el).text().toLowerCase();
        const fullUrl = new URL(href, resolvedUrl).toString();

        if (
          LINK_TRIGGERS.some(trigger =>
            href.toLowerCase().includes(trigger) || txt.includes(trigger)
          )
        ) {
          candidateLinks.push(fullUrl);
        }
      });

      // Step 3: Scan candidate links (limit 5)
      for (let link of candidateLinks.slice(0, 5)) {
        const result = await scanPage(link);
        results.push(result);
      }
    }

    // Step 4: Only return the positive matches
    const positives = results.filter(r => r.hasCreditApp);

    res.json({
      inputUrl,
      resolvedUrl,
      siteActive,
      statusCode,
      hasCreditApp: positives.length > 0,
      hits: positives
    });
  } catch (err) {
    res.status(500).json({ inputUrl, resolvedUrl, error: err.message, hasCreditApp: false });
  }
});

// --------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Render app running on port ${PORT}`);
  console.log(`📋 Using keywords: ${KEYWORDS.join(', ')}`);
  console.log(`🔗 Link triggers: ${LINK_TRIGGERS.join(', ')}`);
});
