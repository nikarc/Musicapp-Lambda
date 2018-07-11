const { SPOTIFY_CLIENTID, SPOTIFY_SECRET, SEATGEEK_API_KEY } = process.env;
const fetch = require('node-fetch');
const { Client } = require('pg');

const seatgeekApiUrl = 'https://api.seatgeek.com/2';
const seatgeekAuth = `client_id=${SEATGEEK_API_KEY}`;

const Spotify = require('spotify-web-api-node');

const spotify = new Spotify({
  clientId: SPOTIFY_CLIENTID,
  clientSecret: SPOTIFY_SECRET,
});

let userId;

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
    // set to monday of next week
    date.setDate(date.getDate() + 7);
  }
}

/**
 * Get artists for nearby venues
 */

function getArtists(user) {
  return new Promise(async (resolve, reject) => {
    const date = new Date();
    setToMondayOfNextWeek(date);
    let eventsList = [];

    for (let i = 0; i < 7; i += 1) {
      if (i > 0) date.setDate(date.getDate() + 1);
      const dateString = date.toISOString().split('T')[0];

      try {
        const sgUrl = `${seatgeekApiUrl}/events?venue.city=${user.city}&datetime_utc=${dateString}&taxonomies.name=concert&${seatgeekAuth}&per_page=5`;
        const eventData = await fetch(sgUrl);
        const eventDataJson = await eventData.json();
        const { events } = eventDataJson;

        eventsList = eventsList.concat(events);
      } catch (err) {
        return reject(err);
      }
    }

    const artists = {};
    eventsList.forEach((e) => {
      const [performer] = e.performers;
      if (!artists[e.id]) artists[e.id] = [];
      artists[e.id].push(performer);
    });

    return resolve(artists);
  });
}

/**
 *
 * @param {Object} user User object
 *
 * Creates a new playlist for user
 */
function createPlaylist(user, client) {
  return new Promise(async (resolve, reject) => {
    if (user.sptplaylistid) return resolve(user.sptplaylistid);
    try {
      // Create spotify playlist
      const createData = await spotify.createPlaylist(user.username, 'Upcoming Artists In Your City', { public: false });
      const playlist = createData.body;

      await client.query('UPDATE users SET sptplaylistid = $1 WHERE id = $2', [playlist.id, user.id]);

      return resolve(playlist.id);
    } catch (err) {
      console.error('ERROR: ', err);
      return reject(err);
    }
  });
}

/**
 * Get spotiify tracks from artists list
 */
function getTracks(artists, user, accessToken, sptPlaylistId, client) {
  return new Promise(async (resolve, reject) => {
    const trackPromises = [];

    let tracks = [];
    let trackDBPromises;
    let playlistId;

    try {
      // Get user id from postgres db
      const userIdQuery = 'SELECT id FROM users WHERE username = $1';
      const userValues = [user.username];

      const { rows } = await client.query(userIdQuery, userValues);
      console.log('after query');
      if (!rows[0]) return reject(new Error('User not found'));

      userId = rows[0].id;
    } catch (err) {
      return reject(err);
    }

    // Save playlist info to db
    let newPlaylist;
    if (!user.playlistid) {
      try {
        const playlistQuery = 'INSERT INTO playlists(sptusername, userid) VALUES ($1, $2) RETURNING id';
        const playlistValues = [user.username, userId];

        const newPlaylistRows = await client.query(playlistQuery, playlistValues);
        [newPlaylist] = newPlaylistRows.rows;

        // Add playlist id to user row
        const pidUserQuery = 'UPDATE users SET playlistid = $1 WHERE id = $2';
        const pidUserValues = [newPlaylist.id, user.id];

        await client.query(pidUserQuery, pidUserValues);
      } catch (err) {
        return reject(err);
      }
    }


    Object.keys(artists).forEach((eventId) => {
      artists[eventId].forEach((artist) => {
        trackPromises.push(new Promise(async (artistResolve, artistReject) => {
          // Search seetgeek artist on spotify
          let spotifyArtist;
          try {
            const artistsSearch = await spotify.searchArtists(artist.name);
            // console.log('artistsSearch: ', artistsSearch);
            [spotifyArtist] = artistsSearch.body.artists.items;
          } catch (err) {
            console.error('artist search err: ', err);
            return artistReject(err);
          }

          if (spotifyArtist) {
            let topTracks;
            try {
              // If artist is on Spotify, get top tracks
              const topTracksRes = await spotify.getArtistTopTracks(spotifyArtist.id, 'US');
              topTracks = topTracksRes.body.tracks;
            } catch (err) {
              console.error(err);
              return artistReject(err);
            }

            if (topTracks.length) {
              const tracksSlice = topTracks.slice(0, 2);
              // Map top tracks to Spotify URI format. Use URI to add to playlist
              tracks = tracks.concat(tracksSlice.map(t => `spotify:track:${t.id}`));

              // Create tracks in postgres db
              trackDBPromises = tracksSlice.map((t) => {
                const trackQuery = `INSERT INTO
                                        tracks(title, href, sptid, uri, sptartistsids, sptalbumsids, seatgeekeventid, playlist)
                                      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

                const artistsIdMap = t.artists.map(a => a.id).join(':');
                playlistId = newPlaylist ? newPlaylist.id : user.playlistid;
                console.log('playlistId before insert track: ', playlistId);
                const trackValues = [t.name, t.href, t.id, t.uri, artistsIdMap, t.album.id, eventId, playlistId];

                return client.query(trackQuery, trackValues);
              });

              try {
                await Promise.all(trackDBPromises);
                return artistResolve();
              } catch (err) {
                console.error(err);
                return reject(err);
              }
            }
          }

          // Artist is not on Spotify, ignore
          return artistResolve();
        }));
      });
    });
    try {
      await Promise.all(trackPromises);

      if (user.playlistid !== null) {
        console.log('replace playlist tracks: ', user.sptplaylistid);
        // const replaceData = await spotify.replaceTracksInPlaylist(user.username, user.playlistId, tracks);
        const replaceResponse = await fetch(`https://api.spotify.com/v1/users/${user.username}/playlists/${user.sptplaylistid}/tracks`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            uris: tracks,
          }),
        });
        const replaceJson = await replaceResponse.json();

        if (!replaceResponse.ok) {
          return reject(replaceJson);
        }
        console.log('Data: ', replaceJson);
        return resolve(user.playlistid);
      }
      console.log('playlist id: ', user.username, playlistId, tracks);
      await spotify.addTracksToPlaylist(user.username, sptPlaylistId, tracks);
      console.log('after add tracks to playlist');
      return resolve(tracks);
    } catch (err) {
      console.error(err);
      return reject(err);
    }
  });
}

async function main(event, context, callback) {
  const { user, accessToken } = event;

  let artists;
  let tracks;

  spotify.setAccessToken(accessToken);

  const client = new Client();
  await client.connect();

  const oldQueryFunc = client.query;
  client.query = (q, v) => {
    // wrap client.query to log all queries to console
    console.log('QUERY: ', q, v);
    return oldQueryFunc.apply(client, [q, v]);
  };

  const artistTimeStart = new Date();
  try {
    artists = await getArtists(user, client);
    console.log(`Get Artists time: ${(new Date().getTime() - artistTimeStart.getTime()) / 1000}`);
  } catch (err) {
    console.error('Error getting artists: ', err);
    return callback(err);
  }

  const playlistTime = new Date();
  let sptPlaylistId;
  try {
    sptPlaylistId = await createPlaylist(user, client);
    console.log(`Create playlist time: ${(new Date().getTime() - playlistTime.getTime()) / 1000}`);
  } catch (err) {
    console.error(err);
    return callback(err);
  }

  const tracksTime = new Date();
  try {
    console.log('get tracks');
    tracks = await getTracks(artists, user, accessToken, sptPlaylistId, client);
    console.log(`Get Tracks time: ${(new Date().getTime() - tracksTime.getTime()) / 1000}`);
    if (!tracks) {
      console.error('Tracks undefined');
      return callback(new Error('Tracks undefined'));
    }
  } catch (err) {
    console.error('TRACKS ERR: ', err);
    return callback(err);
  } finally {
    console.log('should release');
    client.end();
  }

  console.log('NO ERRORS');
  return callback(null, sptPlaylistId);
}

exports.handler = main;
