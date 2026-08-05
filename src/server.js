import { loadEnv } from './env.js';
import { openDb, DB_PATH } from './db.js';

loadEnv();
import { createApp } from './app.js';

const db = openDb();
const { app, notifier } = createApp(db, { dbPath: DB_PATH });

notifier.start();

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`ISMS API běží na http://localhost:${port} (DB: ${DB_PATH})`);
});
