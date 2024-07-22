require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');

const app = express();
const port = process.env.PORT || 8080;

app.use(bodyParser.json());

const SCOPES = ['https://www.googleapis.com/auth/forms', 'https://www.googleapis.com/auth/drive.file'];
const TOKEN_PATH = 'token.json';

const client_id = process.env.GOOGLE_API_CLIENT_ID;
const client_secret = process.env.GOOGLE_API_CLIENT_SECRET;
const redirect_uri = process.env.GOOGLE_API_REDIRECT_URI;

const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

fs.readFile(TOKEN_PATH, (err, token) => {
  if (err || !token.length) {
    return getNewToken(oAuth2Client);
  }
  try {
    oAuth2Client.setCredentials(JSON.parse(token));
    startServer(oAuth2Client);
  } catch (e) {
    console.error('Error parsing token file:', e);
    getNewToken(oAuth2Client);
  }
});

function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error retrieving access token', err);
      oAuth2Client.setCredentials(token);
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) return console.error(err);
        console.log('Token stored to', TOKEN_PATH);
      });
      startServer(oAuth2Client);
    });
  });
}

app.get('/oauth2callback', (req, res) => {
  const code = req.query.code;
  oAuth2Client.getToken(code, (err, token) => {
    if (err) return res.status(400).send('Error while trying to retrieve access token');
    oAuth2Client.setCredentials(token);
    fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
      if (err) return console.error(err);
      console.log('Token stored to', TOKEN_PATH);
    });
    res.send('Authentication successful! You can close this window.');
    startServer(oAuth2Client);
  });
});

function startServer(auth) {
  const forms = google.forms({ version: 'v1', auth });

  app.post('/create-form', async (req, res) => {
    const { title, questions } = req.body;

    if (!title || !questions) {
      console.error('Missing title or questions in request body');
      return res.status(400).json({ status: 'error', message: 'Missing title or questions in request body' });
    }

    try {
      // Step 1: Create the form with the title only
      const createFormResponse = await forms.forms.create({
        requestBody: {
          info: {
            title: title,
          },
        },
      });

      const formId = createFormResponse.data.formId;

      // Step 2: Use batchUpdate to add questions
      const requests = questions.map((question, index) => {
        let questionItem = {
          title: question.title,
          questionItem: {
            question: {
              required: true,
            },
          },
        };

        switch (question.type.toUpperCase()) {
          case 'TEXT':
          case 'SHORT_ANSWER':
            questionItem.questionItem.question.textQuestion = {};
            break;
          case 'PARAGRAPH':
            questionItem.questionItem.question.paragraphTextQuestion = {};
            break;
          case 'RADIO':
          case 'MULTIPLE_CHOICE':
            questionItem.questionItem.question.choiceQuestion = {
              type: 'RADIO',
              options: question.options.map(option => ({ value: option })),
            };
            break;
          case 'CHECKBOX':
            questionItem.questionItem.question.choiceQuestion = {
              type: 'CHECKBOX',
              options: question.options.map(option => ({ value: option })),
            };
            break;
          case 'DROPDOWN':
            questionItem.questionItem.question.choiceQuestion = {
              type: 'DROP_DOWN',
              options: question.options.map(option => ({ value: option })),
            };
            break;
          case 'DATE':
            questionItem.questionItem.question.dateQuestion = {};
            break;
          case 'TIME':
            questionItem.questionItem.question.timeQuestion = {};
            break;
          case 'SCALE':
            questionItem.questionItem.question.scaleQuestion = {
              low: 1,
              high: 5,
              lowLabel: 'Low',
              highLabel: 'High',
            };
            break;
          case 'GRID':
            questionItem.questionItem.question.gridQuestion = {
              rows: question.options.rows,
              columns: question.options.columns,
            };
            break;
          case 'MULTIPLE_CHOICE_WITH_OTHER':
            questionItem.questionItem.question.choiceQuestion = {
              type: 'RADIO',
              options: question.options.map(option => ({ value: option })).concat({ value: 'Other' }),
              otherOption: true,
            };
            break;
          case 'SECTION':
            questionItem = {
              title: question.title,
              pageBreakItem: {
                description: question.description || '',
              },
            };
            break;
          default:
            console.log('Unknown question type:', question.type);
        }

        return {
          createItem: {
            item: questionItem,
            location: {
              index: index,
            },
          },
        };
      });

      await forms.forms.batchUpdate({
        formId: formId,
        requestBody: {
          requests: requests,
        },
      });

      res.json({
        status: 'success',
        message: 'Form created successfully',
        formId: formId,
        formUrl: `https://docs.google.com/forms/d/${formId}/viewform`,
      });
    } catch (error) {
      console.error('Error creating form:', error);
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} is already in use.`);
    } else {
      console.error(err);
    }
  });
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${port} is already in use.`);
  } else {
    console.error(err);
  }
});