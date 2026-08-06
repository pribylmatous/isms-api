import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createUser } from './helpers.js';
import { isLocalLoginEnabled } from '../src/auth.js';

describe('přihlášení a role', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
    await createUser(ctx.db, { username: 'ctenar', name: 'Čtenář', role: 'reader', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'editor', name: 'Editor', role: 'editor', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'manazer', name: 'Manažerka', role: 'manager', password: 'Heslo.123' });
  });

  after(() => ctx.close());

  test('nepřihlášený požadavek na chráněný endpoint vrací 401', async () => {
    const res = await ctx.client.get('/api/risks');
    assert.equal(res.status, 401);
  });

  test('neplatné heslo vrací 401 a nenastaví cookie', async () => {
    const res = await ctx.client.post('/api/auth/login', { username: 'ctenar', password: 'spatne' });
    assert.equal(res.status, 401);
    const still = await ctx.client.get('/api/auth/me');
    assert.equal(still.status, 401);
  });

  test('platné přihlášení vrací uživatele a nastaví session cookie', async () => {
    const user = await ctx.client.login('ctenar', 'Heslo.123');
    assert.equal(user.username, 'ctenar');
    assert.equal(user.role, 'reader');
    const me = await ctx.client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.username, 'ctenar');
  });

  test('odhlášení zruší session', async () => {
    await ctx.client.login('ctenar', 'Heslo.123');
    const out = await ctx.client.post('/api/auth/logout');
    assert.equal(out.status, 204);
    const me = await ctx.client.get('/api/auth/me');
    assert.equal(me.status, 401);
  });

  test('reader smí číst, ale ne zapisovat (403)', async () => {
    await ctx.client.login('ctenar', 'Heslo.123');
    const read = await ctx.client.get('/api/risks');
    assert.equal(read.status, 200);
    const write = await ctx.client.post('/api/risks', {
      name: 'X', asset: 'Y', probability: 1, impact: 1, owner: 'J. Kovářová',
    });
    assert.equal(write.status, 403);
  });

  test('editor smí zapisovat, ale ne mazat (403)', async () => {
    await ctx.client.login('editor', 'Heslo.123');
    const created = await ctx.client.post('/api/risks', {
      name: 'Riziko editora', asset: 'Aktivum', probability: 2, impact: 2, owner: 'J. Kovářová',
    });
    assert.equal(created.status, 201);
    const del = await ctx.client.del(`/api/risks/${created.body.id}`);
    assert.equal(del.status, 403);
  });

  test('manažer smí mazat', async () => {
    await ctx.client.login('editor', 'Heslo.123');
    const created = await ctx.client.post('/api/risks', {
      name: 'Riziko ke smazání', asset: 'Aktivum', probability: 1, impact: 1, owner: 'J. Kovářová',
    });
    await ctx.client.login('manazer', 'Heslo.123');
    const del = await ctx.client.del(`/api/risks/${created.body.id}`);
    assert.equal(del.status, 204);
  });

  test('deaktivovaný účet se nepřihlásí, i se správným heslem', async () => {
    await createUser(ctx.db, { username: 'deaktivovany', name: 'Deaktivovaný', role: 'reader', password: 'Heslo.123' });
    await ctx.db.prepare("UPDATE users SET active = 0 WHERE username = 'deaktivovany'").run();
    const res = await ctx.client.post('/api/auth/login', { username: 'deaktivovany', password: 'Heslo.123' });
    assert.equal(res.status, 401);
  });
});

describe('rate limiting přihlášení', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
    await createUser(ctx.db, { username: 'ratelimit', name: 'Rate Limit', role: 'reader', password: 'Heslo.123' });
  });

  after(() => ctx.close());

  test('po 5 neúspěšných pokusech na stejný účet vrátí 429 s Retry-After', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await ctx.client.post('/api/auth/login', { username: 'ratelimit', password: 'spatne' });
      assert.equal(res.status, 401, `pokus ${i + 1} by měl vrátit 401`);
    }
    const blocked = await ctx.client.post('/api/auth/login', { username: 'ratelimit', password: 'spatne' });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'), 'měl by být nastavený Retry-After');

    // I se správným heslem zůstává zablokovaný, dokud limit nevyprší
    const correctButBlocked = await ctx.client.post('/api/auth/login', { username: 'ratelimit', password: 'Heslo.123' });
    assert.equal(correctButBlocked.status, 429);
  });

  test('úspěšné přihlášení vyčistí počítadlo neúspěšných pokusů', async () => {
    await createUser(ctx.db, { username: 'ratelimit2', name: 'Rate Limit 2', role: 'reader', password: 'Heslo.123' });
    for (let i = 0; i < 3; i++) {
      const res = await ctx.client.post('/api/auth/login', { username: 'ratelimit2', password: 'spatne' });
      assert.equal(res.status, 401);
    }
    const ok = await ctx.client.login('ratelimit2', 'Heslo.123');
    assert.equal(ok.username, 'ratelimit2');

    // Počítadlo se resetovalo — další 4 neúspěšné pokusy (< limit 5) ještě neblokují
    for (let i = 0; i < 4; i++) {
      const res = await ctx.client.post('/api/auth/login', { username: 'ratelimit2', password: 'spatne' });
      assert.equal(res.status, 401, `pokus ${i + 1} po resetu by neměl být blokovaný`);
    }
  });
});

describe('vypnutí lokálního přihlášení (DISABLE_LOCAL_LOGIN)', () => {
  const ENV_KEYS = ['DISABLE_LOCAL_LOGIN', 'ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET'];
  let saved;

  before(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  });

  after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  test('příznak bez nakonfigurovaného SSO se ignoruje (pojistka proti zamknutí)', () => {
    delete process.env.ENTRA_TENANT_ID;
    delete process.env.ENTRA_CLIENT_ID;
    delete process.env.ENTRA_CLIENT_SECRET;
    process.env.DISABLE_LOCAL_LOGIN = '1';
    assert.equal(isLocalLoginEnabled(), true);
  });

  test('příznak s nakonfigurovaným SSO vypne lokální přihlášení', () => {
    process.env.ENTRA_TENANT_ID = 't';
    process.env.ENTRA_CLIENT_ID = 'c';
    process.env.ENTRA_CLIENT_SECRET = 's';
    process.env.DISABLE_LOCAL_LOGIN = '1';
    assert.equal(isLocalLoginEnabled(), false);
  });

  test('vypnuté lokální přihlášení: POST /api/auth/login vrací 404, config to hlásí', async () => {
    process.env.ENTRA_TENANT_ID = 't';
    process.env.ENTRA_CLIENT_ID = 'c';
    process.env.ENTRA_CLIENT_SECRET = 's';
    process.env.DISABLE_LOCAL_LOGIN = '1';

    const ctx = await startTestServer();
    try {
      await createUser(ctx.db, { username: 'zamceny', name: 'Zamčený', role: 'reader', password: 'Heslo.123' });
      const res = await ctx.client.post('/api/auth/login', { username: 'zamceny', password: 'Heslo.123' });
      assert.equal(res.status, 404);

      const config = await ctx.client.get('/api/auth/config');
      assert.equal(config.body.localLoginEnabled, false);
      assert.equal(config.body.ssoEnabled, true);
    } finally {
      await ctx.close();
    }
  });
});
