-- To run this against D1: `npx wrangler d1 execute diplomatic --local --file=src/schema.sql`
DROP TABLE IF EXISTS users;
CREATE TABLE IF NOT EXISTS users (
  pubKey TEXT PRIMARY KEY
);

DROP TABLE IF EXISTS envelopes;
CREATE TABLE IF NOT EXISTS envelopes (
  userPubKey TEXT,
  recordedAt TEXT,
  sha256 BLOB,
  headCry BLOB,
  bodyCry BLOB,
  PRIMARY KEY (userPubKey, sha256)
);
