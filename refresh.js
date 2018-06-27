#!/usr/local/bin/node

require('dotenv').config();
const {
  SPOTIFY_CLIENTID, SPOTIFY_SECRET, refreshToken, accessToken,
} = process.env;
const { Pool } = require('pg');
const pool = new Pool();

const Spotify = require('spotify-web-api-node');

const spotify = new Spotify({
  clientId: SPOTIFY_CLIENTID,
  clientSecret: SPOTIFY_SECRET,
});

spotify.setAccessToken(accessToken);
spotify.setRefreshToken(refreshToken);

(async () => {
  try {
    const refresh = await spotify.refreshAccessToken();
    console.log('REFRESH: ', refresh.body.access_token);
    const tokenExpires = new Date();
    tokenExpires.setHours(tokenExpires.getHours() + 1);

    const client = await pool.connect();

    const oldQueryFunc = client.query;
    client.query = (q, v) => {
      // wrap client.query to log all queries to console
      console.log('QUERY: ', q, v);
      return oldQueryFunc.apply(client, [q, v]);
    };

    await client.query('UPDATE users SET spttoken = $1, tokenexpires = $2 WHERE id = 9', [refresh.body.access_token, tokenExpires]);

    return process.exit(0);
  } catch (err) {
    console.error(err);
    return process.exit(1);
  }
})();
