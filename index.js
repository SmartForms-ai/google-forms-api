const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { google } = require('googleapis');
const axios = require('axios');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later.'
});
app.use(limiter);

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  CALLBACK_URL,
} = process.env;

// Use the PORT environment variable provided by Cloud Run, default to 8080 if not set
const SERVER_PORT = process.env.PORT || 8080;

// Add logging to verify the port configuration
console.log(`PORT from environment: ${process.env.PORT}`);
console.log(`Server will start on port: ${SERVER_PORT}`);

(async () => {
  // Specify a compatible MongoDB version
  const mongoServer = await MongoMemoryServer.create({
    binary: {
      version: '5.0.8', // Use a version compatible with your architecture
    },
  });
  const mongoUri = mongoServer.getUri();

  mongoose.connect(mongoUri);

  mongoose.connection.on('connected', () => {
    console.log('Connected to in-memory MongoDB');
  });

  mongoose.connection.on('error', (err) => {
    console.error('Error connecting to in-memory MongoDB:', err);
  });

  const tokenSchema = new mongoose.Schema({
    accessToken: String,
    refreshToken: String,
    expiryDate: Number,
    userId: String
  });

  const Token = mongoose.model('Token', tokenSchema);

  const saveTokensToDB = async (tokens, userId) => {
    const expiryDate = tokens.expiry_date || (Date.now() + tokens.expires_in * 1000);

    const token = new Token({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: expiryDate,
      userId: userId
    });

    await token.save();
    console.log('Tokens saved to DB', token);
  };

  const getTokensFromDB = async (userId) => {
    const token = await Token.findOne({ userId }).sort({ _id: -1 }).exec();
    if (token) {
      console.log('Tokens read from DB', token);
      return token;
    } else {
      console.log('No tokens found in DB');
      return null;
    }
  };

  const clearTokens = async (userId) => {
    await Token.deleteMany({ userId });
    console.log('Tokens cleared for user', userId);
  };

  app.get('/oauth/authorize', async (req, res) => {
    const userId = req.query.user_id;
    await clearTokens(userId);
    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      CALLBACK_URL
    );

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/forms', 'https://www.googleapis.com/auth/drive.file'],
      prompt: 'consent',
      state: userId
    });

    console.log('Redirecting to Google for authentication', authUrl);
    res.redirect(authUrl);
  });

  app.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    const userId = state;
    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      CALLBACK_URL
    );

    try {
      console.log('Authorization code received', code);

      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);

      await saveTokensToDB(tokens, userId);
      res.send('Authentication successful! You can close this window.');
    } catch (error) {
      console.error('Error retrieving tokens', error.response ? error.response.data : error.message);
      res.status(400).send('Error retrieving tokens');
    }
  });

  const refreshAccessToken = async (oauth2Client, tokens) => {
    try {
      oauth2Client.setCredentials({ refresh_token: tokens.refreshToken });
      const newTokens = await oauth2Client.refreshAccessToken();
      return newTokens.credentials;
    } catch (error) {
      console.error('Error refreshing token', error);
      throw error;
    }
  };

  app.post('/create-form', async (req, res) => {
    const { userId, title, questions } = req.body;
    console.log('Received request body', req.body);

    if (!userId || !title || !questions) {
      console.error('Missing userId, title, or questions', { userId, title, questions });
      return res.status(400).json({ status: 'error', message: 'Missing userId, title, or questions' });
    }

    try {
      let tokens = await getTokensFromDB(userId);
      if (!tokens || tokens.expiryDate <= Date.now()) {
        if (tokens && tokens.refreshToken) {
          console.log('Tokens expired. Refreshing...');
          const oauth2Client = new google.auth.OAuth2(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            CALLBACK_URL
          );
          tokens = await refreshAccessToken(oauth2Client, tokens);
          await saveTokensToDB(tokens, userId);
        } else {
          console.error('No valid tokens found. Please authenticate first.');
          return res.status(401).json({ status: 'error', message: 'No valid tokens found. Please authenticate first.' });
        }
      }

      const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CALLBACK_URL);
      oauth2Client.setCredentials({ access_token: tokens.accessToken });

      const createFormResponse = await axios.post(
        'https://forms.googleapis.com/v1/forms',
        {
          info: { title }
        },
        {
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`
          }
        }
      );

      const formId = createFormResponse.data.formId;
      console.log('Form created with ID', formId);

      const requests = questions.map((question, index) => {
        let questionItem = {
          title: question.title,
          questionItem: { question: { required: true } },
        };

        switch (question.type) {
          case 'text':
            questionItem.questionItem.question.textQuestion = {};
            break;
          case 'multipleChoice':
            questionItem.questionItem.question.choiceQuestion = {
              type: 'RADIO',
              options: question.options.map(option => ({ value: option })),
            };
            break;
          default:
            throw new Error(`Unsupported question type: ${question.type}`);
        }
        return { createItem: { item: questionItem, location: { index } } };
      });

      const batchUpdateResponse = await axios.post(
        `https://forms.googleapis.com/v1/forms/${formId}:batchUpdate`,
        { requests },
        {
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`
          }
        }
      );

      console.log('Form updated with questions', batchUpdateResponse.data);

      res.json({ status: 'success', message: 'Form created successfully', formUrl: `https://docs.google.com/forms/d/${formId}/viewform` });
    } catch (error) {
      console.error('Error creating form', error.response ? error.response.data : error.message);
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  app.listen(SERVER_PORT, async () => {
    console.log(`Server is running on port ${SERVER_PORT}`);

    // Dynamically import the open package
    const open = await import('open');
    // Automatically open the URL in the default browser
    await open.default(`http://localhost:${SERVER_PORT}/oauth/authorize?user_id=testuser`);
  });
})();