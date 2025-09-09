import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

// Salesforce OAuth + instance details
const SF_INSTANCE_URL = process.env.SF_INSTANCE_URL;
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_PASSWORD = process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN;

// Confirmation page base URL (VF or LWC page in Salesforce)
const CONFIRM_URL = process.env.CONFIRM_URL || `${SF_INSTANCE_URL}/apex/SyndicationConfirm`;

let accessToken = null;

// Get Salesforce access token
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

  if (!res.ok) {
    throw new Error(`Failed to authenticate with Salesforce: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  accessToken = data.access_token;
  return accessToken;
}

// Route: sync and redirect
app.get('/sync/:oppId', async (req, res) => {
  try {
    const oppId = req.params.oppId;
    if (!oppId) {
      return res.redirect(`${CONFIRM_URL}?message=Missing+Opportunity+Id`);
    }

    if (!accessToken) {
      await getAccessToken();
    }

    let sfResponse = await fetch(`${SF_INSTANCE_URL}/services/apexrest/syndication/request`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        oppid: oppId
      }
    });

    // Handle token expiry
    if (sfResponse.status === 401) {
      await getAccessToken();
      sfResponse = await fetch(`${SF_INSTANCE_URL}/services/apexrest/syndication/request`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          oppid: oppId
        }
      });
    }

    const data = await sfResponse.json();
    const msg = encodeURIComponent(
      data.status === 'SUCCESS'
        ? 'Status Updated Successfully'
        : `Error: ${data.message}`
    );

    // Redirect user to confirmation page with result
    res.redirect(`${CONFIRM_URL}?message=${msg}`);

  } catch (err) {
    const msg = encodeURIComponent(`Exception: ${err.message}`);
    res.redirect(`${CONFIRM_URL}?message=${msg}`);
  }
});

app.listen(PORT, () => {
  console.log(`Render app running on port ${PORT}`);
});
