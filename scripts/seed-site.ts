// scripts/seed-site.ts
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';

const dbPath = process.env.DB_PATH ?? './ashs.sqlite3';
const domain = process.argv[2];
const name   = process.argv[3] ?? domain;

if (!domain) {
  console.error('Usage: bun run scripts/seed-site.ts <domain> [name]');
  process.exit(1);
}

const db     = new Database(dbPath);
const apiKey = randomBytes(32).toString('hex');
const stmt   = db.prepare('INSERT INTO approved_sites (domain, api_key, name, rate_limit_rpm) VALUES (' + '?' + ', ' + '?' + ', ' + '?' + ', ' + '?' + ')');
stmt.run(domain, apiKey, name, 120);

console.log('');
console.log('Site added: ' + domain);
console.log('API Key:    ' + apiKey);
console.log('Save this key - not shown again!');
db.close();