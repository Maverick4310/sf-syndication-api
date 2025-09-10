import express from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const app = express();
const PORT = process.env.PORT || 3000;

// Env vars for Salesforce
const SF_INSTANCE_URL = process.env.SF_INSTANCE_URL;
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_PASSWORD = process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN;
const CONFIRM_URL = process.env.CONFIRM_URL || `${SF_INSTANCE_URL}/apex/SyndicationConfirm`;

let accessToken = null;

// Keywords
const DEFAULT_KEYWORDS = [
  "apply", "apply now", "application", "apply online", "apply today",
  "credit", "credit app", "credit application", "credit approval", "get credit",
  "finance", "financing", "financing options", "finance application",
  "finance request", "financing program", "get financed",
  "loan", "loan application", "get approved", "pre-approve", "pre-approval",
  "get a quote", "request a quote", "quote request",
  "shop", "shopping", "add to cart", "checkout", "buy now", "order now",
  "preowned"
];
const KEYWORDS = DEFAULT_KEYWORDS.map(k => k.toLowerCase());

const LINK_TRIGGERS = [
  "finance", "credit", "apply", "loan", "inventory",
  "equipment", "machinery", "trucks", "products", "quote",
  "shop", "cart", "checkout", "buy", "order", "preowned"
];

// --------------------------------------------------
// Salesforce Auth
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
// Route 1: Syndication API
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
    res.status(500).json({ status: 'FAIL', message: err.message });
  }
});

// --------------------------------------------------
// Dealer Scanning Helpers
// --------------------------------------------------
async function scanStatic(url) {
  try {
    const response = await fetch(url, { timeout: 15000 });
    const html = await response.text();
    let matchedKeywords = [];

    const $ = cheerio.load(html);

    // Full text
    const pageText = $('body').text().toLowerCase();
    KEYWORDS.forEach((kw) => {
      if (pageText.includes(kw)) matchedKeywords.push(kw);
    });

    // Elements
    $('a, button, form').each((_, el) => {
      const txt = ($(el).text() || '').toLowerCase().trim();
      const href = (($(el).attr('href') || '').toLowerCase().trim()).replace(/&amp;/g, "&");
      const action = (($(el).attr('action') || '').toLowerCase().trim());

      KEYWORDS.forEach((kw) => {
        if (txt.includes(kw) || href.includes(kw) || action.includes(kw)) {
          matchedKeywords.push(kw);
        }
      });
    });

    return { url, hasCreditApp: matchedKeywords.length > 0, matchedKeywords: [...new Set(matchedKeywords)] };
  } catch (err) {
    return { url, error: err.message, hasCreditApp: false, matchedKeywords: [] };
  }
}

async function scanDynamic(url) {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });

    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    let matchedKeywords = [];
    KEYWORDS.forEach((kw) => {
      if (bodyText.includes(kw)) matchedKeywords.push(kw);
    });

    await browser.close();
    return { url, hasCreditApp: matchedKeywords.length > 0, matchedKeywords: [...new Set(matchedKeywords)], usedDynamic: true };
  } catch (err) {
    if (browser) await browser.close();
    return { url, error: "Puppeteer error: " + err.message, hasCreditApp: false, matchedKeywords: [], usedDynamic: true };
  }
}

// --------------------------------------------------
// Route 2: Dealer Financing Scanner
// --------------------------------------------------
app.get('/dealer/check', async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) return res.status(400).json({ error: 'Missing ?url parameter' });

  let resolvedUrl = inputUrl.startsWith('http') ? inputUrl : `https://${inputUrl}`;

  try {
    // Check site
    let siteActive = false;
    let statusCode = null;
    try {
      const resp = await fetch(resolvedUrl, { method: 'GET', redirect: "follow", timeout: 12000 });
      statusCode = resp.status;
      siteActive = statusCode >= 200 && statusCode < 500;
      resolvedUrl = resp.url;
    } catch (err) {
      siteActive = false;
    }

    const results = [];
    let homepageResult = await scanStatic(resolvedUrl);
    if (!homepageResult.hasCreditApp) homepageResult = await scanDynamic(resolvedUrl);
    results.push(homepageResult);

    // Candidate links
    if (!homepageResult.error) {
      const response = await fetch(resolvedUrl, { timeout: 15000 });
      const html = await response.text();
      const $ = cheerio.load(html);

      const candidateLinks = [];
      $('a').each((_, el) => {
        let href = (($(el).attr('href') || '').toLowerCase().trim()).replace(/&amp;/g, "&");
        let txt = ($(el).text() || '').toLowerCase().trim();
        try {
          const fullUrl = new URL(href, resolvedUrl).toString();
          if (LINK_TRIGGERS.some(trigger => href.includes(trigger) || txt.includes(trigger))) {
            candidateLinks.push(fullUrl);
          }
        } catch (e) {}
      });

      for (let link of candidateLinks.slice(0, 5)) {
        let result = await scanStatic(link);
        if (!result.hasCreditApp) result = await scanDynamic(link);
        results.push(result);
      }
    }

    const positives = results.filter(r => r.hasCreditApp);

    res.json({ inputUrl, resolvedUrl, siteActive, statusCode, hasCreditApp: positives.length > 0, hits: positives });
  } catch (err) {
    res.status(500).json({ inputUrl, resolvedUrl, error: err.message, hasCreditApp: false });
  }
});

// --------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Render app running on port ${PORT}`);
  console.log(`📡 Routes available: /sync/:oppId and /dealer/check?url=...`);
});
