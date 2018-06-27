CREATE TABLE users(
  id SERIAL PRIMARY KEY NOT NULL,
  uri TEXT NOT NULL,
  city TEXT NOT NULL,
  sptrefreshtoken TEXT NOT NULL,
  spttoken TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL
);

CREATE TABLE playlists(
  id SERIAL PRIMARY KEY  NOT NULL,
  sptusername TEXT    NOT NULL,
  createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  userid INT REFERENCES users(id)
);

CREATE TABLE tracks(
  id SERIAL PRIMARY KEY  NOT NULL,
  title TEXT NOT NULL,
  href TEXT NOT NULL,
  sptid TEXT NOT NULL,
  uri TEXT NOT NULL,
  sptartistsids TEXT NOT NULL,
  sptalbumsids TEXT NOT NULL,
  seatgeekvenueid INT NOT NULL,
  playlist INT REFERENCES playlists(id)
);