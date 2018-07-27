const { SPOTIFY_CLIENTID, SPOTIFY_SECRET, SEATGEEK_API_KEY } = process.env;
const fetch = require('node-fetch');
const { Client } = require('pg');

const seatgeekApiUrl = 'https://api.seatgeek.com/2';
const seatgeekAuth = `client_id=${SEATGEEK_API_KEY}`;

let sptplaylistid;
let playlistId;
let accessToken;
let oldTracksRows;

// Helper
function setToMondayOfNextWeek(date) {
  // get day
  const day = date.getDay() || 7;
  // if not already monday
  if (day > 1) {
    // get monday
    const difference = day - 1;
    // set to monday
    date.setDate(date.getDate() - difference);
  }
  // set to monday of next week
  date.setDate(date.getDate() + 7);

  return date;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function spotifyWrapper(url, method = 'GET', body = {}, tries = 10) {
  if (tries === 0) return Promise.reject(new Error('Timedout, too many 502 responses'));
  if (tries > 0) await delay(500);

  const sptBody = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };
  if (method !== 'GET') sptBody.body = JSON.stringify(body);
  const spotifyRes = await fetch(`https://api.spotify.com/v1/${url}`, sptBody);
  if (spotifyRes.status === 502) {
    console.log('502 tries: ', tries);
    // Retry
    tries -= 1;
    return spotifyWrapper(url, method, body, tries);
  }

  const json = await spotifyRes.json();

  if (!spotifyRes.ok) return Promise.reject(json);

  return Promise.resolve(json);
}

const createPlaylist = async function createPlaylist(client, user) {
  ({ sptplaylistid } = user);
  const { username } = user;
  if (!sptplaylistid) {
    try {
      // Create spotify playlist
      // const sptPlaylistRes = await fetch(`https://api.spotify.com/v1/users/${username}/playlists`, {
      //   method: 'POST',
      //   headers: {
      //     Authorization: `Bearer ${accessToken}`,
      //     'Content-Type': 'application/json',
      //   },
      //   body: JSON.stringify({
      //     name: 'Upcoming Artists In Your Area',
      //     public: false,
      //   }),
      // });
      const sptPlaylistJson = await spotifyWrapper(`${username}/playlists`, 'POST', {
        name: 'Upcoming Artists In Your Area',
        public: false,
      });

      // if (!sptPlaylistRes.ok) return Promise.reject(sptPlaylistJson);
      // console.log('PLAYLIST: ', sptPlaylistJson.id);

      sptplaylistid = sptPlaylistJson.id;
    } catch (err) {
      console.error('Create spotify playlist error: ', err);
      return Promise.reject(err);
    }
  }
  try {
    playlistId = user.playlistid;
    if (!user.playlistid) {
      // Check if playlist exists
      const { rows: existingRows } = await client.query('SELECT id FROM playlists WHERE sptusername = $1', [username]);
      const [existingPlaylist] = existingRows;

      if (!existingPlaylist) {
        // Create db playlist
        const expiresatDate = new Date();
        setToMondayOfNextWeek(expiresatDate);
        expiresatDate.setDate(expiresatDate.getDate() - 1); // Set to next upcoming Sunday
        const { rows } = await client.query('INSERT INTO playlists (userid, sptusername, sptplaylistid, expiresat) VALUES ($1, $2, $3, $4) ON CONFLICT (sptusername) DO NOTHING RETURNING id', [user.id, username, sptplaylistid, expiresatDate]);
        const [playlist] = rows;
        playlistId = playlist.id;
      } else {
        playlistId = existingPlaylist.id;
      }
    }

    // update user
    await client.query('UPDATE users SET sptplaylistid = $1, playlistid = $2', [sptplaylistid, playlistId]);

    return Promise.resolve(sptplaylistid);
  } catch (err) {
    console.error('Create playlist db error: ', err);
    return Promise.reject(err);
  }
};

const getArtists = async function getArtists(client, user) {
  let eventsList = [];
  const date = new Date();
  setToMondayOfNextWeek(date);

  // Iterate through every day next week and create a seatgeek url
  const eventUrls = [];
  for (let i = 0; i < 7; i += 1) {
    if (i > 0) date.setDate(date.getDate() + 1);
    const dateString = date.toISOString().split('T')[0];
    eventUrls.push(`${seatgeekApiUrl}/events?venue.city=${user.city}&datetime_utc=${dateString}&taxonomies.name=concert&${seatgeekAuth}&per_page=5`);
  }

  // Make call to seatgeek with urls
  const eventPromises = eventUrls.map(async (sgUrl) => {
    try {
      const eventData = await fetch(sgUrl);
      const eventDataJson = await eventData.json();
      const { events } = eventDataJson;

      eventsList = eventsList.concat(events);
      return Promise.resolve();
    } catch (err) {
      console.error('Event fetch error: ', err);
      return Promise.reject(err);
    }
  });

  try {
    await Promise.all(eventPromises);
  } catch (err) {
    console.error('eventPromises error: ', err);
    return Promise.reject(err);
  }

  // Format artists from eventsList
  const artists = {};
  eventsList.forEach((e) => {
    const [performer] = e.performers;
    if (!artists[e.id]) artists[e.id] = [];
    artists[e.id].push(performer);
  });

  return Promise.resolve(artists);
};

// Get and insert tracks
const insertTracksToDB = async (tracks, eventId, client) => {
  const insertPromises = tracks.map(async (t) => {
    try {
      // Get old tracks to delete later
      ({ rows: oldTracksRows } = await client.query('SELECT id FROM tracks WHERE playlist = $1', [playlistId]));
      const q = `INSERT INTO
                    tracks(title, href, sptid, uri, sptartistsids, sptalbumsids, seatgeekeventid, playlist)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

      const artistsIdMap = t.artists.map(a => a.id).join(':');
      const values = [t.name, t.href, t.id, t.uri, artistsIdMap, t.album.id, eventId, playlistId];
      await client.query(q, values);

      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  });

  try {
    await Promise.all(insertPromises);

    return Promise.resolve();
  } catch (err) {
    console.error('Insert tracks error: ', err);
    return Promise.reject(err);
  }
};

const addTracksToPlaylist = async (uris, username, removeOldTracks = false) => {
  try {
    // Remove old tracks if playlist already created
    if (removeOldTracks) {
      // First get query playlist and map track uris
      // const playlistRes = await fetch(`https://api.spotify.com/v1/users/${username}/playlists/${sptplaylistid}/tracks`, {
      //   headers: {
      //     Authorization: `Bearer ${accessToken}`,
      //   },
      // });
      // const playlistJson = await playlistRes.json();

      // if (!playlistRes.ok) return Promise.reject(playlistJson);

      const playlistJson = await spotifyWrapper(`users/${username}/playlists/${sptplaylistid}/tracks`);

      // Map tracks
      const removeTrackUris = playlistJson.items.map((t) => { return { uri: t.track.uri } });
      console.log('REMOVE TRACKS URIS: ', removeTrackUris);

      // await fetch(`https://api.spotify.com/v1/users/${username}/playlists/${sptplaylistid}/tracks`, {
      //   method: 'DELETE',
      //   headers: {
      //     Authorization: `Bearer ${accessToken}`,
      //     'Content-Type': 'application/json',
      //   },
      //   body: JSON.stringify({ tracks: removeTrackUris }),
      // });
      await spotifyWrapper(`users/${username}/playlists/${sptplaylistid}/tracks`, 'DELETE', { tracks: removeTrackUris });
    }
    // await fetch(`https://api.spotify.com/v1/users/${username}/playlists/${sptplaylistid}/tracks`, {
    //   method: 'POST',
    //   headers: {
    //     Authorization: `Bearer ${accessToken}`,
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify({ uris }),
    // });

    await spotifyWrapper(`users/${username}/playlists/${sptplaylistid}/tracks`, 'POST', { uris });

    return Promise.resolve();
  } catch (err) {
    console.error('Add tracks to playlist error: ', err);
    return Promise.reject(err);
  }
};

const getTracks = async function getTracks(client, artists, username) {
  // Iterate through artists and get top tracks
  // console.log('artists: ', artists);
  const sptArtists = [];
  const trackPromises = Object.keys(artists).map(async (eventId) => {
    const [a] = artists[eventId];
    const searchQuery = `artist:${encodeURIComponent(a.name)}&type=artist`;
    // const url = `https://api.spotify.com/v1/search?q=${searchQuery}`;
    // console.log('the url: ', url);
    // const artistSearchRes = await fetch(url, {
    //   method: 'GET',
    //   headers: {
    //     Authorization: `Bearer ${accessToken}`,
    //   },
    // });
    // const artistSearchJson = await artistSearchRes.json();

    // if (!artistSearchRes.ok) {
    //   console.error('Artist search error: ', artistSearchJson);
    //   return Promise.reject(artistSearchJson);
    // }

    const artistSearchJson = await spotifyWrapper(`search?q=${searchQuery}`);

    const artist = artistSearchJson.artists.items[0];
    if (artist) {
      artist.eventId = eventId;
      sptArtists.push(artist);
    }
    return Promise.resolve();
  });

  try {
    await Promise.all(trackPromises);
  } catch (err) {
    console.error('trackPromises Error: ', err);
    return Promise.reject(err);
  }

  // Get top 2 tracks for each artist
  let trackUris = [];
  console.log('spt artist length: ', sptArtists.length);
  const topTracksProimses = sptArtists.map(async (a) => {
    try {
      // const topTracksRes = await fetch(`https://api.spotify.com/v1/artists/${a.id}/top-tracks?country=US`, {
      //   headers: {
      //     Authorization: `Bearer ${accessToken}`,
      //   },
      // });
      // const topTracksJson = await topTracksRes.json();

      // if (!topTracksRes.ok) {
      //   return Promise.reject(topTracksJson);
      // }

      const topTracksJson = await spotifyWrapper(`artists/${a.id}/top-tracks?country=US`);

      const { tracks } = topTracksJson;
      if (!(tracks && tracks.length)) return Promise.resolve();

      const trackSlice = tracks.slice(0, 2);
      // Map track uris to use when adding to playlist
      trackUris = trackUris.concat(trackSlice.map(t => `spotify:track:${t.id}`));
      // insert tracks into db
      await insertTracksToDB(trackSlice, a.eventId, client);

      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  });
  try {
    await Promise.all(topTracksProimses);
    // Add tracks to spotify playlist
    await addTracksToPlaylist(trackUris, username, !!playlistId);

    // Remove old tracks
    const removeValues = oldTracksRows.map(i => i.id).join(',');
    console.log('REMOVE VALUES: ', removeValues);
    client.query(`DELETE FROM tracks WHERE id IN (${removeValues})`);
  } catch (err) {
    console.error('Top tracks error: ', err);
    return Promise.reject();
  }

  return Promise.resolve();
};

const handler = async function handler(event, context, callback) {
  const { user } = event;
  let dbUser;
  const client = new Client();
  await client.connect();

  const oldQueryFunc = client.query;
  client.query = (q, v) => {
    // wrap client.query to log all queries to console
    console.log('QUERY: ', q, v);
    return oldQueryFunc.apply(client, [q, v]);
  };

  let artists;

  // Get user from db
  try {
    const { rows } = await client.query('SELECT * FROM users WHERE username = $1', [user.username]);
    [dbUser] = rows;
  } catch (err) {
    console.error(err);
    return callback(err);
  }

  ({ spttoken: accessToken } = dbUser);

  // Create Playlist
  try {
    await createPlaylist(client, dbUser);
    console.log('PLAYLIST CREATED');
  } catch (err) {
    client.end();
    return callback(err);
  }

  // Get Artists
  try {
    artists = await getArtists(client, dbUser);
    console.log('GOT ARTISTS');
  } catch (err) {
    client.end();
    return callback(err);
  }

  // Get Tracks
  try {
    await getTracks(client, artists, dbUser.username, dbUser.sptplaylistid);
    console.log('CREATED TRACKS');
  } catch (err) {
    client.end();
    return callback(err);
  }

  client.end();
  console.log('THERE WERE NO ERRORS');
  return callback();
};

exports.handler = handler;
