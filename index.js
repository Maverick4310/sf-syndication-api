import express from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

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
  "apply", "apply now", "application", "apply online", "apply today",
  "credit", "credit app", "credit application", "credit approval", "get credit",
  "finance", "financing", "financing options", "finance application",
  "finance request", "financing program", "get financed",
  "loan", "loan application", "get approved", "pre-approve", "pre-approval",
  "get a quote", "request a quote", "quote request",
  "shop", "shopping", "add to cart", "checkout", "buy now", "order now",
  "preowned"
];
const KEYWORDS = process.env.CREDIT_KEYWORDS
  ? process.env.CREDIT_KEYWORDS.split(',').map(k => k.trim().toLowerCase())
  : DEFAULT_KEYWORDS.map(k => k.toLowerCase());

// Candidate link triggers
const LINK_TRIGGERS = [
  "finance", "credit", "apply", "loan", "inventory",
  "equipment", "machinery", "trucks", "products", "quote",
  "shop", "cart", "checkout", "buy", "order", "preowned"
];

let accessToken = null;

// --------------------------------------------------
// Helper: Normalize and Resolve URL with Redirects
// --------------------------------------------------
async function resolveUrl(rawUrl) {
  if (!rawUrl) return null;
  let input = rawUrl.trim();

  if (input.startsWith("http://") || input.startsWith("https://")) {
    return input;
  }

  const attempts = [
    "https://" + input,
    "http://" + input
  ];

  if (!input.startsWith("www.")) {
    attempts.push("https://www." + input);
    attempts.push("http://www." + input);
  }

  for (let url of attempts) {
    try {
      const resp = await fetch(url, { method: "GET", redirect: "follow", timeout: 12000 });
      if (resp.status >= 200 && resp.status < 500) {
        return resp.url;
      }
    } catch (err) {}
  }

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
// Helper: Scan page with Cheerio (loose, full text + elements)
// --------------------------------------------------
async function scanStatic(url) {
  try {
    const response = await fetch(url, { timeout: 15000 });
    const html = await response.text();
    let matchedKeywords = [];

    const $ = cheerio.load(html);

    // 🔹 Scan full body text
    const pageText = $('body').text().toLowerCase();
    KEYWORDS.forEach((kw) => {
      if (pageText.includes(kw)) matchedKeywords.push(kw);
    });

    // 🔹 Also scan actionable elements
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
// Helper: Scan page with Puppeteer (dynamic JS fallback)
// --------------------------------------------------
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
    return {
      url,
      hasCreditApp: matchedKeywords.length > 0,
      matchedKeywords: [...new Set(matchedKeywords)],
      usedDynamic: true
    };
  } catch (err) {
    if (browser) await browser.close();
    return { url, error: "Puppeteer error: " + err.message, hasCreditApp: false, matchedKeywords: [], usedDynamic: true };
  }
}

// --------------------------------------------------
// Route: Dealer Credit/Financing Application Checker
// --------------------------------------------------
app.get('/dealer/check', async (req, res) => {
  const inputUrl = req.query.url;
  let resolvedUrl = await resolveUrl(inputUrl);
  if (!resolvedUrl) return res.status(400).json({ error: 'Missing ?url parameter' });

  try {
    // Site active check
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

    // Scan homepage
    let homepageResult = await scanStatic(resolvedUrl);

    // 🔹 Fallback: if no hits → Puppeteer
    if (!homepageResult.hasCreditApp) {
      homepageResult = await scanDynamic(resolvedUrl);
    }
    results.push(homepageResult);

    // Candidate links from homepage
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

          if (
            LINK_TRIGGERS.some(trigger =>
              href.includes(trigger) || txt.includes(trigger)
            )
          ) {
            candidateLinks.push(fullUrl);
          }
        } catch (e) {
          // skip malformed hrefs
        }
      });

      for (let link of candidateLinks.slice(0, 5)) {
        let result = await scanStatic(link);
        if (!result.hasCreditApp) {
          result = await scanDynamic(link); // fallback
        }
        results.push(result);
      }
    }

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
