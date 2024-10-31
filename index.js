const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

// Middleware should be placed before your routes to parse request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 8080;
const OPENAI_PLUGIN_ID = process.env.OPENAI_PLUGIN_ID;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const OPENAI_REDIRECT_URI = process.env.OPENAI_REDIRECT_URI;

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
    return res.status(400).json({ error: 'redirect_uri and state are required' });
  }

  // Validate the redirect_uri against the expected one
  if (openaiRedirectUri !== OPENAI_REDIRECT_URI) {
    console.error('Invalid redirect_uri');
    return res.status(400).json({ error: 'Invalid redirect_uri' });
  }

  // Use OpenAI's redirect_uri when generating the Google authorization URL
  const redirectUri = openaiRedirectUri;

  // Initialize OAuth2 client with OpenAI's redirect_uri
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    redirectUri
  );

  // Generate the Google OAuth2 authorization URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/forms',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
    ],
    state: openaiState, // Pass OpenAI's state parameter to Google
    prompt: 'consent',
  });

  console.log(`Generated Auth URL: ${authUrl}`);
  res.redirect(authUrl);
});

// OAuth2 callback endpoint
app.get('/oauth/callback', async (req, res) => {
  // Since we used OpenAI's redirect_uri, Google will redirect back to OpenAI, not to this endpoint
  res.status(400).json({ error: 'Invalid request' });
});

// OAuth2 token exchange endpoint
app.post('/oauth/token', async (req, res) => {
  console.log('Received token exchange request');
  // Avoid logging sensitive data
  console.log('Request Headers:', req.headers);
  // Log request body keys without values
  console.log('Request Body Keys:', Object.keys(req.body));

  const { code, grant_type, redirect_uri, client_id, client_secret } = req.body;

  if (!code) {
    console.error('Missing code parameter');
    return res.status(400).json({ error: 'Missing code parameter' });
  }

  if (!grant_type) {
    console.error('Missing grant_type parameter');
    return res.status(400).json({ error: 'Missing grant_type parameter' });
  }

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'Unsupported grant type' });
  }

  if (!redirect_uri) {
    console.error('Missing redirect_uri parameter');
    return res.status(400).json({ error: 'Missing redirect_uri parameter' });
  }

  if (!client_id || !client_secret) {
    console.error('Missing client_id or client_secret');
    return res.status(400).json({ error: 'Missing client_id or client_secret' });
  }

  // Validate redirect_uri against the expected one from environment variables
  if (redirect_uri !== OPENAI_REDIRECT_URI) {
    console.error('Invalid redirect_uri');
    return res.status(400).json({ error: 'Invalid redirect_uri' });
  }

  // Validate client_id and client_secret
  if (client_id !== GOOGLE_CLIENT_ID) {
    console.error('Invalid client_id');
    return res.status(400).json({ error: 'Invalid client_id' });
  }

  if (client_secret !== GOOGLE_CLIENT_SECRET) {
    console.error('Invalid client_secret');
    return res.status(400).json({ error: 'Invalid client_secret' });
  }

  // Initialize OAuth2 client with credentials and redirect_uri from the request
  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uri
  );

  try {
    // Exchange the authorization code for tokens
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

// Endpoint to create or update a Google Form
app.post('/create-form', async (req, res) => {
  const { title, description, questions } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const accessToken = authHeader.split(' ')[1];
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });

  const forms = google.forms({ version: 'v1', auth: oauth2Client });

  try {
    // Validate request body
    if (!title || !questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    // Create a new form
    const createResponse = await forms.forms.create({
      requestBody: {
        info: {
          title,
          description,
        },
      },
    });

    const formId = createResponse.data.formId;
    console.log(`Form created with ID ${formId}`);

    // Build requests to add questions
    const requests = [];

    questions.forEach((question, index) => {
      let item;

      if (question.type === 'multiple_choice') {
        item = {
          title: question.title,
          questionItem: {
            question: {
              required: question.required,
              choiceQuestion: {
                type: 'RADIO',
                options: question.options.map((option) => ({ value: option })),
              },
            },
          },
        };
      } else if (question.type === 'checkbox') {
        item = {
          title: question.title,
          questionItem: {
            question: {
              required: question.required,
              choiceQuestion: {
                type: 'CHECKBOX',
                options: question.options.map((option) => ({ value: option })),
              },
            },
          },
        };
      } else if (question.type === 'short_answer') {
        item = {
          title: question.title,
          questionItem: {
            question: {
              required: question.required,
              textQuestion: {
                paragraph: false,
              },
            },
          },
        };
      } else if (question.type === 'paragraph') {
        item = {
          title: question.title,
          questionItem: {
            question: {
              required: question.required,
              textQuestion: {
                paragraph: true,
              },
            },
          },
        };
      } else if (question.type === 'dropdown') {
        item = {
          title: question.title,
          questionItem: {
            question: {
              required: question.required,
              choiceQuestion: {
                type: 'DROP_DOWN',
                options: question.options.map((option) => ({ value: option })),
              },
            },
          },
        };
      } else {
        throw new Error(`Unsupported question type: ${question.type}`);
      }

      requests.push({
        createItem: {
          item,
          location: {
            index,
          },
        },
      });
    });

    // Batch update to add questions
    await forms.forms.batchUpdate({
      formId,
      requestBody: {
        requests,
      },
    });

    // Get the form's URL
    const formResponse = await forms.forms.get({
      formId,
      fields: 'responderUri',
    });

    const formLink = formResponse.data.responderUri;
    console.log(`Form link: ${formLink}`);

    // Return the form link to the user
    res.json({
      message: 'Form created successfully',
      form_link: formLink,
    });
  } catch (error) {
    console.error('Error creating/updating form', error);
    res.status(500).json({ error: 'An error occurred while creating the form.' });
  }
});

// Endpoint to list the user's forms
app.get('/list-forms', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res
      .status(401)
      .json({ status: 'error', message: 'Authorization header missing' });
  }

  const accessToken = authHeader.split(' ')[1];

  try {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Query for files of type Google Forms
    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.form'",
      fields: 'files(id, name)',
    });

    const forms = response.data.files;
    res.json({ status: 'success', forms });
  } catch (error) {
    console.error('Error listing forms', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});