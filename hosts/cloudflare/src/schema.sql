-- To run this against D1: `npx wrangler d1 execute diplomatic --local --file=src/schema.sql`
DROP TABLE IF EXISTS users;
CREATE TABLE IF NOT EXISTS users (
  pubKey TEXT PRIMARY KEY
);

DROP TABLE IF EXISTS ops;
CREATE TABLE IF NOT EXISTS ops (
  userPubKey TEXT,
  recordedAt TEXT,
  op BLOB,
  size INT,
  PRIMARY KEY (userPubKey, recordedAt)
);
