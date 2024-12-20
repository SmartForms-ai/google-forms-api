// index.js

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Stripe initialization
const cron = require('node-cron'); // For scheduling tasks
require('dotenv').config();

const app = express();

// Middleware to parse request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 8080;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const OPENAI_REDIRECT_URI = process.env.OPENAI_REDIRECT_URI;
const MONGO_URI = process.env.MONGO_URI;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Import Mongoose
const mongoose = require('mongoose');

// Connect to MongoDB Atlas
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;

db.on('connected', () => {
  console.log('Connected to MongoDB Atlas');
});

db.on('error', (err) => {
  console.error('MongoDB connection error:', err);
});

// Define User schema and model
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  usageCount: { type: Number, default: 0 },
  hasPaid: { type: Boolean, default: false },
  stripeCustomerId: { type: String },
  subscriptionStatus: { type: String }, // e.g., 'active', 'past_due', 'canceled'
});

const User = mongoose.model('User', userSchema);

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
      'https://www.googleapis.com/auth/userinfo.email',
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
    // Get User Info
    const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
    const userInfoResponse = await oauth2.userinfo.get();
    const userEmail = userInfoResponse.data.email;

    if (!userEmail) {
      return res.status(400).json({ error: 'Unable to retrieve user email' });
    }

    // Check Usage Limits
    let user = await User.findOne({ email: userEmail });

    if (!user) {
      // New user, create a record
      user = new User({ email: userEmail });
    }

    // Check if the user has an active subscription or hasn't exceeded the free quota
    if (
      user.usageCount >= 5 &&
      (!user.subscriptionStatus || user.subscriptionStatus !== 'active')
    ) {
      // User has reached the free usage limit and is not subscribed
      return res.status(402).json({
        error:
          'Free usage limit reached. Please upgrade your plan to continue using the service.',
      });
    }

    // Validate request body
    if (!title || !questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    // Step 1: Create a new form with only the title
    const createResponse = await forms.forms.create({
      requestBody: {
        info: {
          title, // Only include the title here
        },
      },
    });

    const formId = createResponse.data.formId;
    console.log(`Form created with ID ${formId}`);

    // Step 2: Build batchUpdate requests to add description and questions
    const requests = [];

    // Add the form description
    if (description) {
      requests.push({
        updateFormInfo: {
          info: {
            description,
          },
          updateMask: 'description',
        },
      });
    }

    // Add questions to the form
    questions.forEach((question, index) => {
      let item;

      if (question.type === 'multiple_choice') {
        item = {
          title: question.title,
          questionItem: {
            question: {
              required: question.required || false,
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
              required: question.required || false,
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
              required: question.required || false,
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
              required: question.required || false,
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
              required: question.required || false,
              choiceQuestion: {
                type: 'DROP_DOWN',
                options: question.options.map((option) => ({ value: option })),
              },
            },
          },
        };
      } else if (question.type === 'date') {
        // Handling Date Questions
        item = {
          title: question.title,
          questionItem: {
            question: {
              required: question.required || false,
              dateQuestion: {
                includeTime: question.includeTime || false,
                includeYear: question.includeYear !== false, // Defaults to true unless explicitly set to false
              },
            },
          },
        };
      } else if (question.type === 'time') {
        // Handling Time Questions
        item = {
          title: question.title,
          questionItem: {
            question: {
              required: question.required || false,
              timeQuestion: {},
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

    // Step 3: Execute batchUpdate to apply the changes
    await forms.forms.batchUpdate({
      formId,
      requestBody: {
        requests,
      },
    });

    // Step 4: Retrieve the form's URL
    const formResponse = await forms.forms.get({
      formId,
      fields: 'responderUri',
    });

    const formLink = formResponse.data.responderUri;
    console.log(`Form link: ${formLink}`);

    // Update Usage Count
    user.usageCount += 1;
    await user.save();

    // Return the form link to the user
    res.json({
      message: 'Form created successfully',
      form_link: formLink,
    });
  } catch (error) {
    console.error('Error creating/updating form:', error.message);
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

// Endpoint to create a Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const accessToken = authHeader.split(' ')[1];
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });

  try {
    // Get User Info
    const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
    const userInfoResponse = await oauth2.userinfo.get();
    const userEmail = userInfoResponse.data.email;

    if (!userEmail) {
      return res.status(400).json({ error: 'Unable to retrieve user email' });
    }

    // Find or create the user in your database
    let user = await User.findOne({ email: userEmail });

    if (!user) {
      user = new User({ email: userEmail });
      await user.save();
    }

    // Create or retrieve the Stripe customer
    let customer;
    if (user.stripeCustomerId) {
      customer = await stripe.customers.retrieve(user.stripeCustomerId);
    } else {
      customer = await stripe.customers.create({
        email: userEmail,
      });
      user.stripeCustomerId = customer.id;
      await user.save();
    }

    // Create the Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [
        {
          price: 'price_1Hh1XYZ...', // Replace with your actual Price ID
          quantity: 1,
        },
      ],
      mode: 'subscription', // Use 'payment' for one-time charges
      success_url:
        'https://yourdomain.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://yourdomain.com/cancel',
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Error creating checkout session:', error.message);
    res
      .status(500)
      .json({ error: 'An error occurred while creating the checkout session.' });
  }
});

// Stripe Webhook endpoint
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log('Webhook signature verification failed:', err.message);
      return res.sendStatus(400);
    }

    // Handle the event
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const subscriptionStatus = subscription.status;

        // Find the user in your database and update subscription status
        const user = await User.findOne({ stripeCustomerId: customerId });
        if (user) {
          user.subscriptionStatus = subscriptionStatus;
          user.hasPaid = subscriptionStatus === 'active';
          await user.save();
        }
        break;
      case 'invoice.payment_failed':
        // Handle payment failure
        const invoice = event.data.object;
        const customerIdFailed = invoice.customer;

        const userFailed = await User.findOne({
          stripeCustomerId: customerIdFailed,
        });
        if (userFailed) {
          userFailed.subscriptionStatus = 'past_due';
          userFailed.hasPaid = false;
          await userFailed.save();
        }
        break;
      // ... handle other event types if needed
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.sendStatus(200);
  }
);

// Schedule a cron job to reset usage counts at midnight on the first day of every month
cron.schedule('0 0 1 * *', async () => {
  try {
    await User.updateMany({}, { usageCount: 0 });
    console.log('Usage counts have been reset');
  } catch (error) {
    console.error('Error resetting usage counts:', error);
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});