import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createUser } from './helpers.js';

describe('řízení incidentů bezpečnosti informací (ITIL, A.5.24–A.5.30)', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
    await createUser(ctx.db, { username: 'editor', name: 'Editor', role: 'editor', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'manazer', name: 'Manažerka', role: 'manager', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'ctenar', name: 'Čtenář', role: 'reader', password: 'Heslo.123' });
    await ctx.db.prepare("INSERT INTO controls (id, name, domain, status, owner, updated_at) VALUES ('A.5.26', 'Reakce na incidenty', 'Organizační', 'Zavedeno', 'SOC', ?)").run(new Date().toISOString());
    await ctx.db.prepare("INSERT INTO risks (id, name, asset, score, level, owner, created_at, updated_at) VALUES ('R-01', 'Test riziko', 'Aktivum', 9, 'Vysoké', 'SOC', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
  });

  after(() => ctx.close());

  const need = () => ({
    title: 'Phishingový e-mail', category: 'Phishing', priority: 'Vysoká',
    reported_by: 'HR oddělení', owner: 'SOC tým', occurred_at: '2026-07-29',
  });

  test('reader nesmí založit incident (403)', async () => {
    await ctx.client.login('ctenar', 'Heslo.123');
    const res = await ctx.client.post('/api/incidents', need());
    assert.equal(res.status, 403);
  });

  test('vytvoření incidentu s vazbou na riziko', async () => {
    await ctx.client.login('editor', 'Heslo.123');
    const res = await ctx.client.post('/api/incidents', { ...need(), risk_id: 'R-01' });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'Nové');
    assert.equal(res.body.risk_id, 'R-01');
  });

  test('neplatná vazba na opatření vrací 400', async () => {
    const res = await ctx.client.post('/api/incidents', { ...need(), control_id: 'A.99.99' });
    assert.equal(res.status, 400);
  });

  test('chybějící povinné pole (occurred_at) vrací 400', async () => {
    const { occurred_at, ...withoutDate } = need();
    const res = await ctx.client.post('/api/incidents', withoutDate);
    assert.equal(res.status, 400);
  });

  test('úprava stavu na Vyřešeno a doplnění řešení', async () => {
    const created = await ctx.client.post('/api/incidents', need());
    const updated = await ctx.client.put(`/api/incidents/${created.body.id}`, {
      status: 'Vyřešeno', resolved_at: '2026-07-30', resolution: 'Uživatel proškolen, e-mail zablokován.',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.status, 'Vyřešeno');
    assert.equal(updated.body.resolution, 'Uživatel proškolen, e-mail zablokován.');
  });

  test('smazání linkovaného opatření nastaví control_id na null', async () => {
    await ctx.db.prepare("INSERT INTO controls (id, name, domain, status, owner, updated_at) VALUES ('A.5.99', 'Zaniklé opatření', 'Organizační', 'Zavedeno', 'SOC', ?)").run(new Date().toISOString());
    const created = await ctx.client.post('/api/incidents', { ...need(), control_id: 'A.5.99' });
    await ctx.db.prepare("DELETE FROM controls WHERE id = 'A.5.99'").run();

    const list = await ctx.client.get('/api/incidents');
    const found = list.body.find((i) => i.id === created.body.id);
    assert.equal(found.control_id, null);
  });

  test('editor nesmí mazat, manažer smí', async () => {
    const created = await ctx.client.post('/api/incidents', need());
    const denied = await ctx.client.del(`/api/incidents/${created.body.id}`);
    assert.equal(denied.status, 403);

    await ctx.client.login('manazer', 'Heslo.123');
    const del = await ctx.client.del(`/api/incidents/${created.body.id}`);
    assert.equal(del.status, 204);
  });
});
