import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const SF_INSTANCE_URL = process.env.SF_INSTANCE_URL;
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_PASSWORD = process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN;
const CONFIRM_URL = process.env.CONFIRM_URL || `${SF_INSTANCE_URL}/apex/SyndicationConfirm`;

let accessToken = null;

// Helper: authenticate with Salesforce
async function getAccessToken() {
  console.log('🔑 Requesting new Salesforce access token...');
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

  console.log(`🔐 Token response status: ${res.status}`);
  if (!res.ok) {
    const errText = await res.text();
    console.error('❌ Failed to authenticate with Salesforce:', errText);
    throw new Error(`Auth failed: ${errText}`);
  }

  const data = await res.json();
  console.log('✅ Access token received');
  accessToken = data.access_token;
  return accessToken;
}

// Route: sync an Opportunity
app.get('/sync/:oppId', async (req, res) => {
  const oppId = req.params.oppId;
  console.log('➡️ Incoming request for Opportunity Id:', oppId);

  try {
    if (!oppId) {
      console.error('❌ No Opportunity Id provided');
      return res.status(400).json({ status: 'FAIL', message: 'Missing Opportunity Id' });
    }

    if (!accessToken) {
      console.log('⚡ No access token cached, requesting new one...');
      await getAccessToken();
    }

    console.log('📡 Calling Salesforce Apex REST endpoint...');
    let sfResponse = await fetch(`${SF_INSTANCE_URL}/services/apexrest/syndication/request`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        oppid: oppId
      }
    });

    console.log('📡 Salesforce response status:', sfResponse.status);

    // Handle expired token
    if (sfResponse.status === 401) {
      console.warn('⚠️ Token expired, requesting new token...');
      await getAccessToken();
      sfResponse = await fetch(`${SF_INSTANCE_URL}/services/apexrest/syndication/request`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          oppid: oppId
        }
      });
      console.log('📡 Retry response status:', sfResponse.status);
    }

    const data = await sfResponse.json();
    console.log('✅ Salesforce response body:', data);

    const msg = data.status === 'SUCCESS'
      ? 'Status Updated Successfully'
      : `Error: ${data.message}`;

    // For API clients (like Postman) → JSON
    if (req.headers['accept'] && req.headers['accept'].includes('application/json')) {
      console.log('🔄 Returning JSON to client');
      res.json({ status: data.status, message: msg });
    } else {
      console.log('🔄 Redirecting to confirmation page:', CONFIRM_URL);
      res.redirect(`${CONFIRM_URL}?message=${encodeURIComponent(msg)}`);
    }

  } catch (err) {
    console.error('❌ Exception in /sync route:', err.message);

    if (req.headers['accept'] && req.headers['accept'].includes('application/json')) {
      res.status(500).json({ status: 'FAIL', message: err.message });
    } else {
      res.redirect(`${CONFIRM_URL}?message=${encodeURIComponent('Exception: ' + err.message)}`);
    }
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Render app running on port ${PORT}`);
});
