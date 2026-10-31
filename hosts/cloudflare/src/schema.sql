-- To run this against D1: `npx wrangler d1 execute diplomatic --local --file=src/schema.sql`
DROP TABLE IF EXISTS users;
CREATE TABLE IF NOT EXISTS users (
  pubKey TEXT PRIMARY KEY
);

DROP TABLE IF EXISTS bags;
CREATE TABLE IF NOT EXISTS bags (
  userPubKey TEXT,
  rlm BLOB,
  seq INTEGER,
  headCph BLOB,
  bodyCph BLOB, -- null when the body is stored in R2
  bodyKey TEXT, -- R2 object key when bodyCph is null
  PRIMARY KEY (userPubKey, rlm, seq)
);
