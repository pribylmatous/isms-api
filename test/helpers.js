// Testovací pomůcky: čerstvě vyprázdněná Postgres DB (TEST_DATABASE_URL) +
// skutečně naslouchající instance aplikace (žádný mock HTTP vrstvy) pro každý
// popisný blok, s jednoduchým klientem, který si mezi requesty drží session
// cookie jako prohlížeč.
//
// Na rozdíl od dřívějšího openDb(':memory:') (SQLite, vždy čerstvý soubor) teď
// všechny testovací soubory sdílí jednu Postgres DB — proto ji startTestServer()
// před každým použitím vyprázdní (stejné pořadí jako seed.js) a proto testy
// běží sériově (package.json: node --test --test-concurrency=1), aby si dva
// souběžně běžící soubory navzájem nesmazaly data.

import { loadEnv } from '../src/env.js';
import { openDb, TABLE_ORDER } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';

loadEnv();

export async function startTestServer() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL není nastavené — testy potřebují samostatnou Postgres DB (ne DATABASE_URL, aby se omylem nevyprázdnila dev databáze).');
  }
  const db = await openDb(process.env.TEST_DATABASE_URL);
  for (const t of TABLE_ORDER) {
    await db.exec(`DELETE FROM ${t}`);
  }

  const { app, notifier } = createApp(db);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  };

  return { db, notifier, baseUrl, close, client: makeClient(baseUrl) };
}

export async function createUser(db, { username, name, role, password, email = null, title = role }) {
  await db.prepare('INSERT INTO users (username, name, title, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(username, name, title, email, role, hashPassword(password), new Date().toISOString());
}

function makeClient(baseUrl) {
  let cookie = null;

  async function request(method, path, body) {
    const isForm = body instanceof FormData;
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(isForm || body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    const json = (() => { try { return JSON.parse(text); } catch { return text || null; } })();
    return { status: res.status, headers: res.headers, body: json };
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    del: (path) => request('DELETE', path),
    async login(username, password) {
      const res = await request('POST', '/api/auth/login', { username, password });
      if (res.status !== 200) throw new Error(`Login selhal: ${JSON.stringify(res.body)}`);
      return res.body;
    },
    clearCookie() { cookie = null; },
  };
}
