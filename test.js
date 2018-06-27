require('dotenv').config();
const createUserPlaylist = require('./index');
// const accessToken = 'BQDe1xLzG-iFyp8SswDQ2mct7rTd-TL1eaboI_u1jXDNY-bn0wTsBm1-d3dJppX-gPPtgvz3S-clnDHUBz2EkzO9GAjfNK94Xlu8H5CPVLDO6Ww5EglsdwYwVVrL3szv5s3R36Wnzw5AB06dRjqZ0d6omdYJzLtnkrxsPsT8IN5VhV0hsjQXf4RvRc5-WZR2zXbnkvVoRw';
const { Pool } = require('pg');
const pool = new Pool();

const user = {
  username: 'nikarc321',
  city: 'Brooklyn',
  // playlistId: '2NjjhTpP5YuYzTihtGSV42',
};

(async () => {
  const client = await pool.connect();
  const q = 'SELECT spttoken FROM users';
  const { rows } = await client.query(q);
  const accessToken = rows[0].spttoken;

  createUserPlaylist.handler({ user, accessToken }, null, (err) => {
    if (err) {
      console.error(err);
      return process.exit(1);
    }
    return process.exit(0);
  });
})();
