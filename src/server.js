import { loadEnv } from './env.js';
import { openDb } from './db.js';

loadEnv();
import { createApp } from './app.js';

// Jen název databáze do logu/health checku — nikdy celý DATABASE_URL (obsahuje heslo).
const dbName = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).pathname.slice(1) : undefined;

const db = await openDb();
const { app, notifier } = createApp(db, { dbPath: dbName });

notifier.start();

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`ISMS API běží na http://localhost:${port} (DB: ${dbName})`);
});
