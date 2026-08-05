import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createUser } from './helpers.js';

describe('přihlášení a role', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
    createUser(ctx.db, { username: 'ctenar', name: 'Čtenář', role: 'reader', password: 'Heslo.123' });
    createUser(ctx.db, { username: 'editor', name: 'Editor', role: 'editor', password: 'Heslo.123' });
    createUser(ctx.db, { username: 'manazer', name: 'Manažerka', role: 'manager', password: 'Heslo.123' });
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
    createUser(ctx.db, { username: 'deaktivovany', name: 'Deaktivovaný', role: 'reader', password: 'Heslo.123' });
    ctx.db.prepare("UPDATE users SET active = 0 WHERE username = 'deaktivovany'").run();
    const res = await ctx.client.post('/api/auth/login', { username: 'deaktivovany', password: 'Heslo.123' });
    assert.equal(res.status, 401);
  });
});
