import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DB_PATH = process.env.ISMS_DB ?? path.join(__dirname, '..', 'isms.db');

export function openDb(dbPath = DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  // Migrace existující DB: users.email přibyl po prvním nasazení
  const userCols = db.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => c.name);
  if (!userCols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  // Migrace existující DB: users.active přibylo se správou uživatelů
  if (!userCols.includes('active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  // Migrace existující DB: users.entra_oid přibylo s přihlášením přes Entra ID.
  // SQLite neumí ALTER TABLE ADD COLUMN s UNIQUE přímo — sloupec se přidá bez
  // constraintu a jedinečnost se dodá samostatným unique indexem (funguje
  // stejně, i pro nový schema.sql níže vytvořený rovnou s UNIQUE ve sloupci).
  if (!userCols.includes('entra_oid')) db.exec('ALTER TABLE users ADD COLUMN entra_oid TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_entra_oid ON users (entra_oid)');

  // Migrace existující DB: notifications.body_html přibyl s HTML šablonou e-mailů
  const notificationCols = db.prepare("SELECT name FROM pragma_table_info('notifications')").all().map((c) => c.name);
  if (!notificationCols.includes('body_html')) db.exec('ALTER TABLE notifications ADD COLUMN body_html TEXT');

  // Migrace existující DB: policies.file_* přibylo se skutečným ukládáním dokumentů
  const policyCols = db.prepare("SELECT name FROM pragma_table_info('policies')").all().map((c) => c.name);
  if (!policyCols.includes('file_name')) {
    db.exec(`
      ALTER TABLE policies ADD COLUMN file_name TEXT;
      ALTER TABLE policies ADD COLUMN file_stored TEXT;
      ALTER TABLE policies ADD COLUMN file_size INTEGER;
      ALTER TABLE policies ADD COLUMN file_mime TEXT;
    `);
  }

  // Migrace existující DB: trainings.content přibylo s interaktivními kvízy
  const trainingCols = db.prepare("SELECT name FROM pragma_table_info('trainings')").all().map((c) => c.name);
  if (!trainingCols.includes('content')) db.exec('ALTER TABLE trainings ADD COLUMN content TEXT');
  // Migrace existující DB: target_roles přibylo s cílením školení podle role
  if (!trainingCols.includes('target_roles')) {
    db.exec(`ALTER TABLE trainings ADD COLUMN target_roles TEXT NOT NULL DEFAULT '["reader","editor","manager"]'`);
  }

  return db;
}
