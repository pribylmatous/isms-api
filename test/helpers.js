// Testovací pomůcky: čerstvá in-memory DB + skutečně naslouchající instance
// aplikace (žádný mock HTTP vrstvy) pro každý test, s jednoduchým klientem,
// který si mezi requesty drží session cookie jako prohlížeč.

import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';

export async function startTestServer() {
  const db = openDb(':memory:');
  const { app, notifier } = createApp(db);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const close = () => new Promise((resolve) => server.close(resolve));

  return { db, notifier, baseUrl, close, client: makeClient(baseUrl) };
}

export function createUser(db, { username, name, role, password, email = null, title = role }) {
  db.prepare('INSERT INTO users (username, name, title, email, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, name, title, email, role, hashPassword(password));
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
