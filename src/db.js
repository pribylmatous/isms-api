import pg from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// COUNT(*) je typu bigint (Postgres OID 20) — node-postgres ho defaultně vrací
// jako string (kvůli hodnotám nad Number.MAX_SAFE_INTEGER). V týhle appce jsou
// počty vždycky malé, takže je bezpečnější mít je rovnou jako number (jinak by
// např. `SELECT COUNT(*) AS n ...` výsledek `n === 0` nikdy neprošel).
pg.types.setTypeParser(20, (val) => parseInt(val, 10));

// Pořadí mazání při čištění DB (seed.js, testy) — respektuje FK vazby
// (ON DELETE SET NULL/CASCADE dělá zbytek, ale nezávislé tabulky mažeme
// v tomto pořadí z historických důvodů/čitelnosti).
export const TABLE_ORDER = [
  'controls', 'risks', 'policies', 'audit_findings', 'change_activity', 'changes', 'incident_activity', 'incidents',
  'trainings', 'faqs', 'deadlines', 'settings', 'audit_log', 'notifications', 'sessions', 'users',
];

// SQLite používalo poziční '?' — Postgres chce číslované '$1, $2, …'.
// Převod na jednom místě znamená, že text SQL dotazů (napříč celou appkou)
// nemusí nikdo ručně přepočítávat.
const toPositional = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

// Zachovává stejný tvar volání jako dřívější db.prepare(sql).get/all/run(...)
// (viz auth.js/routes.js/notify.js/audit.js/seed.js) — jen teď async.
function wrapQueryable(queryable) {
  return {
    prepare(sql) {
      const text = toPositional(sql);
      return {
        async get(...params) {
          const res = await queryable.query(text, params);
          return res.rows[0];
        },
        async all(...params) {
          const res = await queryable.query(text, params);
          return res.rows;
        },
        async run(...params) {
          const res = await queryable.query(text, params);
          return { changes: res.rowCount, rows: res.rows };
        },
      };
    },
    async exec(sql) {
      await queryable.query(sql);
    },
  };
}

export async function openDb(connectionString = process.env.DATABASE_URL) {
  const pool = new Pool({ connectionString });
  const db = wrapQueryable(pool);

  db.pool = pool;
  // BEGIN/COMMIT musí běžet na jednom vyhrazeném spojení, ne přes pool (ten by
  // jednotlivé dotazy mohl rozhodit na různá spojení) — používá seed.js.
  db.transaction = async (fn) => {
    const client = await pool.connect();
    const tx = wrapQueryable(client);
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };
  db.close = () => pool.end();

  await db.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  // Migrace existující DB: sloupce přidané po prvním nasazení. Postgres umí
  // ADD COLUMN IF NOT EXISTS přímo — bez ručního zjišťování existence sloupce
  // (na rozdíl od dřívějšího SQLite pragma_table_info přístupu).
  await db.exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT');
  await db.exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1');
  // entra_oid bez UNIQUE přímo u sloupce — jedinečnost řeší samostatný index
  // hned pod tím (funguje stejně, i pro čerstvě vytvořenou DB dle schema.sql).
  await db.exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS entra_oid TEXT');
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_entra_oid ON users (entra_oid)');

  await db.exec('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS body_html TEXT');

  await db.exec('ALTER TABLE policies ADD COLUMN IF NOT EXISTS file_name TEXT');
  await db.exec('ALTER TABLE policies ADD COLUMN IF NOT EXISTS file_stored TEXT');
  await db.exec('ALTER TABLE policies ADD COLUMN IF NOT EXISTS file_size INTEGER');
  await db.exec('ALTER TABLE policies ADD COLUMN IF NOT EXISTS file_mime TEXT');

  await db.exec('ALTER TABLE trainings ADD COLUMN IF NOT EXISTS content TEXT');
  await db.exec(`ALTER TABLE trainings ADD COLUMN IF NOT EXISTS target_roles TEXT NOT NULL DEFAULT '["reader","editor","manager"]'`);

  // Workflow řízení incidentů (přiřazení řešiteli, pozastavení, časová osa).
  // CHECK constraint nejde "ADD COLUMN IF NOT EXISTS" — bezpečně se to řeší
  // DROP/ADD (idempotentní, stejný constraint jde přidat opakovaně).
  await db.exec('ALTER TABLE incidents ADD COLUMN IF NOT EXISTS assigned_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  await db.exec('ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_status_check');
  await db.exec(`ALTER TABLE incidents ADD CONSTRAINT incidents_status_check
    CHECK (status IN ('Nové', 'Přiřazeno', 'V řešení', 'Pozastaveno', 'Eskalováno', 'Vyřešeno', 'Uzavřeno'))`);
  await db.exec(`CREATE TABLE IF NOT EXISTS incident_activity (
    id          INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('status_change', 'assignment', 'comment')),
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_name   TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT,
    note        TEXT,
    at          TEXT NOT NULL
  )`);

  // Workflow řízení změn — stejný princip jako incidenty výše, jen beze
  // změny stavového výčtu (changes ho měl bohatý už předtím).
  await db.exec('ALTER TABLE changes ADD COLUMN IF NOT EXISTS assigned_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  await db.exec(`CREATE TABLE IF NOT EXISTS change_activity (
    id          INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    change_id   TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('status_change', 'assignment', 'comment')),
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_name   TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT,
    note        TEXT,
    at          TEXT NOT NULL
  )`);

  return db;
}
