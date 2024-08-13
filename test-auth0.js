const request = require('request');
require('dotenv').config();

const {
  AUTH0_DOMAIN,
  AUTH0_CLIENT_ID,
  AUTH0_CLIENT_SECRET,
  AUTH0_CALLBACK_URL,
  AUTH0_AUDIENCE
} = process.env;

const options = {
  method: 'POST',
  url: `https://${AUTH0_DOMAIN}/oauth/token`,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_id: AUTH0_CLIENT_ID,
    client_secret: AUTH0_CLIENT_SECRET,
    audience: AUTH0_AUDIENCE,
    grant_type: 'client_credentials'
  })
};

request(options, (error, response, body) => {
  if (error) throw new Error(error);

  console.log('Auth0 Response:', body);
});