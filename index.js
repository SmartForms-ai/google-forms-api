require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Serve oas.json file
app.get('/oas.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'oas.json'));
});

// Handle POST request to create a form
app.post('/create-form', async (req, res) => {
  const { title, questions } = req.body;

  if (!title || !questions) {
    console.error('Missing title or questions in request body');
    return res.status(400).json({ status: 'error', message: 'Missing title or questions in request body' });
  }

  try {
    const response = await axios.post(process.env.GOOGLE_APPS_SCRIPT_WEB_APP_URL, { title, questions }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    res.json(response.data);
  } catch (error) {
    if (error.response) {
      console.error('Response error:', error.response.data);
      console.error('Status code:', error.response.status);
      console.error('Headers:', error.response.headers);
      res.status(500).json({ status: 'error', message: error.response.data });
    } else if (error.request) {
      console.error('No response received:', error.request);
      res.status(500).json({ status: 'error', message: 'No response received from Google Apps Script' });
    } else {
      console.error('Error setting up request:', error.message);
      res.status(500).json({ status: 'error', message: error.message });
    }
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});