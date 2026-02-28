-- To run this against D1: `npx wrangler d1 execute diplomatic --local --file=src/schema.sql`
DROP TABLE IF EXISTS users;
CREATE TABLE IF NOT EXISTS users (
  pubKey TEXT PRIMARY KEY
);

DROP TABLE IF EXISTS bags;
CREATE TABLE IF NOT EXISTS bags (
  userPubKey TEXT,
  seq INTEGER,
  headCph BLOB,
  bodyCph BLOB,
  PRIMARY KEY (userPubKey, seq),
  UNIQUE (userPubKey, seq)
);
