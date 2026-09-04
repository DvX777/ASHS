// scripts/migrate.ts
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const dbPath = process.env.DB_PATH ?? "./ashs.sqlite3";
const dbDir = dirname(dbPath); if (dbDir && dbDir !== ".") mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

const dir = join(import.meta.dir, "../src/db/migrations");
const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();

let ran = 0;
for (const file of files) {
  const sql = readFileSync(join(dir, file), "utf-8");
  console.log(`[Migrate] Running: ${file}`);
  db.run(sql);
  ran++;
}
console.log(`[Migrate] Done. Ran ${ran} migration(s).`);
db.close();
