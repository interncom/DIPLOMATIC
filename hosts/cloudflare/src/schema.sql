-- To run this against D1: `npx wrangler d1 execute diplomatic --local --file=src/schema.sql`
DROP TABLE IF EXISTS users;
CREATE TABLE IF NOT EXISTS users (
  pubKey TEXT PRIMARY KEY
);

DROP TABLE IF EXISTS bag;
CREATE TABLE IF NOT EXISTS bag (
  userPubKey TEXT,
  recordedAt TEXT,
  sha256 BLOB,
  headCph BLOB,
  bodyCph BLOB,
  PRIMARY KEY (userPubKey, sha256)
);
