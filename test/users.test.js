import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createUser } from './helpers.js';

describe('správa uživatelů (jen manažer)', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
    createUser(ctx.db, { username: 'reader', name: 'Čtenář', role: 'reader', password: 'Heslo.123' });
    createUser(ctx.db, { username: 'manager', name: 'Manažerka', role: 'manager', password: 'Heslo.123' });
    createUser(ctx.db, { username: 'manager2', name: 'Manažer Druhý', role: 'manager', password: 'Heslo.123' });
  });

  after(() => ctx.close());

  test('reader nesmí vidět seznam ani vytvořit uživatele (403)', async () => {
    await ctx.client.login('reader', 'Heslo.123');
    const list = await ctx.client.get('/api/users');
    assert.equal(list.status, 403);
    const create = await ctx.client.post('/api/users', { username: 'x', name: 'X', role: 'reader', password: 'Heslo.1234' });
    assert.equal(create.status, 403);
  });

  test('manažer vytvoří uživatele, odpověď nikdy neobsahuje password_hash', async () => {
    await ctx.client.login('manager', 'Heslo.123');
    const res = await ctx.client.post('/api/users', {
      username: 'novy.editor', name: 'Nový Editor', role: 'editor', password: 'BezpecneHeslo1',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.role, 'editor');
    assert.equal(res.body.active, 1);
    assert.equal('password_hash' in res.body, false);

    const list = await ctx.client.get('/api/users');
    assert.ok(list.body.every((u) => !('password_hash' in u)));
  });

  test('duplicitní uživatelské jméno vrací 400', async () => {
    const res = await ctx.client.post('/api/users', { username: 'reader', name: 'X', role: 'reader', password: 'Heslo.1234' });
    assert.equal(res.status, 400);
  });

  test('neplatná role vrací 400', async () => {
    const res = await ctx.client.post('/api/users', { username: 'x2', name: 'X', role: 'superadmin', password: 'Heslo.1234' });
    assert.equal(res.status, 400);
  });

  test('příliš krátké heslo vrací 400', async () => {
    const res = await ctx.client.post('/api/users', { username: 'x3', name: 'X', role: 'reader', password: 'short' });
    assert.equal(res.status, 400);
  });

  test('nově vytvořený uživatel se může přihlásit', async () => {
    await ctx.client.post('/api/users', { username: 'prihlasovac', name: 'P', role: 'reader', password: 'HesloPro.Login' });
    const login = await ctx.client.login('prihlasovac', 'HesloPro.Login');
    assert.equal(login.username, 'prihlasovac');
    await ctx.client.login('manager', 'Heslo.123');
  });

  test('reset hesla umožní přihlášení novým heslem', async () => {
    const created = await ctx.client.post('/api/users', { username: 'resetovany', name: 'R', role: 'reader', password: 'PuvodniHeslo1' });
    await ctx.client.put(`/api/users/${created.body.id}`, { password: 'NoveHeslo123' });

    ctx.client.clearCookie();
    const res = await ctx.client.post('/api/auth/login', { username: 'resetovany', password: 'PuvodniHeslo1' });
    assert.equal(res.status, 401, 'staré heslo by už nemělo fungovat');
    const ok = await ctx.client.login('resetovany', 'NoveHeslo123');
    assert.equal(ok.username, 'resetovany');
    await ctx.client.login('manager', 'Heslo.123');
  });

  test('manažer nesmí deaktivovat sám sebe', async () => {
    const me = await ctx.client.get('/api/auth/me');
    const res = await ctx.client.put(`/api/users/${me.body.id}`, { active: false });
    assert.equal(res.status, 400);
  });

  test('nelze deaktivovat ani degradovat posledního aktivního manažera', async () => {
    // deaktivujeme manager2, aby zbyl jediný aktivní manažer (manager)
    const list = await ctx.client.get('/api/users');
    const manager2 = list.body.find((u) => u.username === 'manager2');
    const deactivated = await ctx.client.put(`/api/users/${manager2.id}`, { active: false });
    assert.equal(deactivated.status, 200);

    const me = await ctx.client.get('/api/auth/me');
    // reaktivujeme manager2, aby zase existovali dva aktivní manažeři
    const reactivate = await ctx.client.put(`/api/users/${manager2.id}`, { active: true });
    assert.equal(reactivate.status, 200);

    const demote = await ctx.client.put(`/api/users/${manager2.id}`, { role: 'editor' });
    assert.equal(demote.status, 200); // teď existují 2 aktivní manažeři, degradace jednoho je OK

    // nyní je 'manager' jediný aktivní manažer opět — pokus o jeho vlastní degradaci by měl selhat
    const selfDemote = await ctx.client.put(`/api/users/${me.body.id}`, { role: 'editor' });
    assert.equal(selfDemote.status, 400);
  });

  test('deaktivace okamžitě odhlásí uživatele (zneplatní session)', async () => {
    const created = await ctx.client.post('/api/users', { username: 'kdeaktivaci', name: 'D', role: 'reader', password: 'HesloProDeakt1' });
    await ctx.client.put(`/api/users/${created.body.id}`, { active: false });

    const check = ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(created.body.id);
    assert.equal(check.n, 0, 'session by měla být smazána při deaktivaci');

    const loginAttempt = await ctx.client.post('/api/auth/login', { username: 'kdeaktivaci', password: 'HesloProDeakt1' });
    assert.equal(loginAttempt.status, 401, 'deaktivovaný účet by se neměl přihlásit');
    ctx.client.clearCookie();
    await ctx.client.login('manager', 'Heslo.123');
  });

  test('audit log zaznamená vytvoření a úpravu uživatele', async () => {
    const created = await ctx.client.post('/api/users', { username: 'proaudit', name: 'Pro Audit', role: 'reader', password: 'HesloProAudit1' });
    await ctx.client.put(`/api/users/${created.body.id}`, { name: 'Přejmenováno' });

    const log = ctx.db.prepare("SELECT * FROM audit_log WHERE entity = 'user' AND entity_id = ? ORDER BY id").all(String(created.body.id));
    assert.equal(log.length, 2);
    assert.equal(log[0].action, 'create');
    assert.equal(log[1].action, 'update');
    assert.deepEqual(JSON.parse(log[1].changes).name, ['Pro Audit', 'Přejmenováno']);
  });
});
