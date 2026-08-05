// Sestavení Express aplikace odděleně od síťového naslouchání (server.js),
// aby šla aplikace přímo spustit i v testech bez skutečného HTTP portu.

import express from 'express';
import cors from 'cors';
import { createAuth } from './auth.js';
import { createNotifier } from './notify.js';
import { createAuditLog } from './audit.js';
import { registerRoutes } from './routes.js';

export function createApp(db, { dbPath } = {}) {
  const auth = createAuth(db);
  const notifier = createNotifier(db);
  const audit = createAuditLog(db);
  const app = express();

  // credentials: true — session cookie. Bez CORS_ORIGIN se origin odráží (dev);
  // v produkci nastavte CORS_ORIGIN na skutečnou adresu portálu (čárkou oddělené
  // hodnoty pro víc domén).
  const allowedOrigins = (process.env.CORS_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true, credentials: true }));
  app.use(express.json());

  app.get('/api/health', (req, res) => res.json({ ok: true, ...(dbPath ? { db: dbPath } : {}) }));

  auth.registerAuthRoutes(app);
  auth.registerSsoRoutes(app);

  // Vše ostatní vyžaduje přihlášení
  app.use(auth.guard);

  registerRoutes(app, db, auth.requireRole, notifier, audit);

  app.use((req, res) => res.status(404).json({ error: 'Endpoint nenalezen' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message ?? 'Interní chyba serveru' });
  });

  return { app, notifier };
}
