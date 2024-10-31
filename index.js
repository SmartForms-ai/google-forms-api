const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

// Add middleware to parse URL-encoded bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 8080;
const OPENAI_PLUGIN_ID = process.env.OPENAI_PLUGIN_ID;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Root endpoint for health checks
app.get('/', (req, res) => {
  res.send('Server is up and running!');
});

// OAuth2 authorization endpoint
app.get('/oauth/authorize', async (req, res) => {
  const openaiRedirectUri = req.query.redirect_uri;
  const openaiState = req.query.state;

  if (!openaiRedirectUri || !openaiState) {
    console.error('Missing OpenAI redirect URI or state');
    return res
      .status(400)
      .json({ error: 'redirect_uri and state are required' });
  }

  // Use the OpenAI redirect URI
  const redirectUri = openaiRedirectUri;

  // Generate the Google OAuth2 authorization URL
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    redirectUri
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/forms',
      'https://www.googleapis.com/auth/drive.file',
    ],
    state: openaiState, // Pass OpenAI's state parameter to Google
    prompt: 'consent',
  });

  console.log(`Generated Auth URL: ${authUrl}`);
  res.redirect(authUrl);
});

// OAuth2 callback endpoint
app.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    console.error('Missing code or state');
    return res.status(400).json({ error: 'Invalid OAuth callback' });
  }

  // Redirect back to OpenAI with code and state
  const redirectUrl = `https://chat.openai.com/aip/${OPENAI_PLUGIN_ID}/oauth/callback?code=${encodeURIComponent(
    code
  )}&state=${encodeURIComponent(state)}`;
  console.log(`Redirecting to OpenAI: ${redirectUrl}`);
  res.redirect(redirectUrl);
});

// OAuth2 token exchange endpoint
app.post('/oauth/token', async (req, res) => {
  // Avoid logging sensitive data
  console.log('Received token exchange request');

  const { code, grant_type, redirect_uri } = req.body;

  if (!code || !grant_type || !redirect_uri) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'Unsupported grant type' });
  }

  // Exchange code for tokens with Google
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    redirect_uri
  );

  try {
    // Include redirect_uri in getToken
    const { tokens } = await oauth2Client.getToken({
      code,
      redirect_uri,
    });

    // Return the tokens to OpenAI
    res.json({
      access_token: tokens.access_token,
      token_type: 'Bearer',
      expires_in: tokens.expiry_date
        ? Math.floor((tokens.expiry_date - Date.now()) / 1000)
        : 3600,
      refresh_token: tokens.refresh_token,
    });
  } catch (error) {
    console.error(
      'Error exchanging code for tokens:',
      error.response ? error.response.data : error.message
    );
    res.status(500).json({ error: 'Failed to exchange code for tokens' });
  }
});

// Endpoint to create a new Google Form (unchanged)
// ... Your existing code for /create-form ...

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});