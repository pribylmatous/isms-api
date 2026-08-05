import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createUser } from './helpers.js';

describe('řízení změn (ITIL, A.8.32)', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
    createUser(ctx.db, { username: 'editor', name: 'Editor', role: 'editor', password: 'Heslo.123' });
    createUser(ctx.db, { username: 'manazer', name: 'Manažerka', role: 'manager', password: 'Heslo.123' });
    createUser(ctx.db, { username: 'ctenar', name: 'Čtenář', role: 'reader', password: 'Heslo.123' });
    // testovací opatření a riziko pro vazby
    ctx.db.prepare("INSERT INTO controls (id, name, domain, status, owner) VALUES ('A.8.32', 'Řízení změn', 'Technologická', 'Zavedeno', 'IT')").run();
    ctx.db.prepare("INSERT INTO risks (id, name, asset, score, level, owner) VALUES ('R-01', 'Test riziko', 'Aktivum', 4, 'Nízké', 'IT')").run();
  });

  after(() => ctx.close());

  test('reader nesmí vytvořit změnu (403)', async () => {
    await ctx.client.login('ctenar', 'Heslo.123');
    const res = await ctx.client.post('/api/changes', { title: 'X', type: 'Normální', risk_level: 'Nízké', owner: 'IT' });
    assert.equal(res.status, 403);
  });

  test('vytvoření změny s vazbou na opatření', async () => {
    await ctx.client.login('editor', 'Heslo.123');
    const res = await ctx.client.post('/api/changes', {
      title: 'Upgrade firewallu', type: 'Normální', risk_level: 'Střední', owner: 'SOC tým', control_id: 'A.8.32',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'Návrh');
    assert.equal(res.body.control_id, 'A.8.32');
    assert.equal(res.body.risk_id, null);
  });

  test('neplatná vazba na opatření vrací 400', async () => {
    const res = await ctx.client.post('/api/changes', {
      title: 'Neplatná vazba', type: 'Normální', risk_level: 'Nízké', owner: 'IT', control_id: 'A.99.99',
    });
    assert.equal(res.status, 400);
  });

  test('úprava stavu a vazby na riziko', async () => {
    const created = await ctx.client.post('/api/changes', {
      title: 'Změna k úpravě', type: 'Standardní', risk_level: 'Nízké', owner: 'IT',
    });
    const updated = await ctx.client.put(`/api/changes/${created.body.id}`, { status: 'Schváleno', risk_id: 'R-01' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.status, 'Schváleno');
    assert.equal(updated.body.risk_id, 'R-01');
  });

  test('smazání linkovaného rizika nastaví risk_id na null (ON DELETE SET NULL)', async () => {
    ctx.db.prepare("INSERT INTO risks (id, name, asset, score, level, owner) VALUES ('R-02', 'Zaniklé riziko', 'Aktivum', 4, 'Nízké', 'IT')").run();
    const created = await ctx.client.post('/api/changes', {
      title: 'Změna s rizikem k zániku', type: 'Normální', risk_level: 'Nízké', owner: 'IT', risk_id: 'R-02',
    });
    await ctx.client.login('manazer', 'Heslo.123');
    await ctx.client.del('/api/risks/R-02');
    await ctx.client.login('editor', 'Heslo.123');

    const list = await ctx.client.get('/api/changes');
    const found = list.body.find((c) => c.id === created.body.id);
    assert.equal(found.risk_id, null);
  });

  test('editor nesmí mazat, manažer smí', async () => {
    const created = await ctx.client.post('/api/changes', {
      title: 'Ke smazání', type: 'Normální', risk_level: 'Nízké', owner: 'IT',
    });
    const deniedDel = await ctx.client.del(`/api/changes/${created.body.id}`);
    assert.equal(deniedDel.status, 403);

    await ctx.client.login('manazer', 'Heslo.123');
    const del = await ctx.client.del(`/api/changes/${created.body.id}`);
    assert.equal(del.status, 204);
  });
});
