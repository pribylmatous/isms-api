import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createUser } from './helpers.js';

describe('řízení změn (ITIL, A.8.32)', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
    await createUser(ctx.db, { username: 'editor', name: 'Editor', role: 'editor', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'manazer', name: 'Manažerka', role: 'manager', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'ctenar', name: 'Čtenář', role: 'reader', password: 'Heslo.123' });
    // testovací opatření a riziko pro vazby
    await ctx.db.prepare("INSERT INTO controls (id, name, domain, status, owner, updated_at) VALUES ('A.8.32', 'Řízení změn', 'Technologická', 'Zavedeno', 'IT', ?)").run(new Date().toISOString());
    await ctx.db.prepare("INSERT INTO risks (id, name, asset, score, level, owner, created_at, updated_at) VALUES ('R-01', 'Test riziko', 'Aktivum', 4, 'Nízké', 'IT', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
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
    assert.equal(res.body.assigned_to_user_id, null);
  });

  test('neplatná vazba na opatření vrací 400', async () => {
    const res = await ctx.client.post('/api/changes', {
      title: 'Neplatná vazba', type: 'Normální', risk_level: 'Nízké', owner: 'IT', control_id: 'A.99.99',
    });
    assert.equal(res.status, 400);
  });

  test('GET /api/changes/:id vrací jednu změnu, neexistující 404', async () => {
    const created = await ctx.client.post('/api/changes', { title: 'Detail test', type: 'Normální', risk_level: 'Nízké', owner: 'IT' });
    const found = await ctx.client.get(`/api/changes/${created.body.id}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.id, created.body.id);
    const missing = await ctx.client.get('/api/changes/CHG-999');
    assert.equal(missing.status, 404);
  });

  test('PUT upraví popisná pole a vazbu na riziko, ale ne stav (ten je jen přes workflow akce)', async () => {
    const created = await ctx.client.post('/api/changes', {
      title: 'Změna k úpravě', type: 'Standardní', risk_level: 'Nízké', owner: 'IT',
    });
    const updated = await ctx.client.put(`/api/changes/${created.body.id}`, { status: 'Schváleno', risk_id: 'R-01' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.status, 'Návrh'); // status v těle PUT se ignoruje
    assert.equal(updated.body.risk_id, 'R-01');
  });

  test('smazání linkovaného rizika nastaví risk_id na null (ON DELETE SET NULL)', async () => {
    await ctx.db.prepare("INSERT INTO risks (id, name, asset, score, level, owner, created_at, updated_at) VALUES ('R-02', 'Zaniklé riziko', 'Aktivum', 4, 'Nízké', 'IT', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
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

    await ctx.client.login('editor', 'Heslo.123');
  });
});

describe('workflow změny: přiřazení a přechody stavu', () => {
  let ctx;
  let editorId;
  let editor2Id;

  before(async () => {
    ctx = await startTestServer();
    await createUser(ctx.db, { username: 'editor', name: 'Editor', role: 'editor', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'editor2', name: 'Druhý editor', role: 'editor', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'ctenar', name: 'Čtenář', role: 'reader', password: 'Heslo.123' });
    editorId = (await ctx.db.prepare("SELECT id FROM users WHERE username = 'editor'").get()).id;
    editor2Id = (await ctx.db.prepare("SELECT id FROM users WHERE username = 'editor2'").get()).id;
    await ctx.client.login('editor', 'Heslo.123');
  });

  after(() => ctx.close());

  const need = () => ({
    title: 'Upgrade firewallu', type: 'Normální', risk_level: 'Střední', owner: 'IT oddělení',
  });

  test('přiřazení realizátora', async () => {
    const created = await ctx.client.post('/api/changes', need());
    const res = await ctx.client.post(`/api/changes/${created.body.id}/assign`, { user_id: editorId });
    assert.equal(res.status, 200);
    assert.equal(res.body.assigned_to_user_id, editorId);
    assert.equal(res.body.status, 'Návrh'); // přiřazení samo o sobě stav nemění
  });

  test('neplatný/neaktivní uživatel při přiřazení vrací 400', async () => {
    const created = await ctx.client.post('/api/changes', need());
    const res = await ctx.client.post(`/api/changes/${created.body.id}/assign`, { user_id: 999999 });
    assert.equal(res.status, 400);
  });

  test('schválit z Návrhu (bez odeslání ke schválení) vrací 409', async () => {
    const created = await ctx.client.post('/api/changes', need());
    const res = await ctx.client.post(`/api/changes/${created.body.id}/approve`, {});
    assert.equal(res.status, 409);
  });

  test('plný životní cyklus: odeslat → schválit → naplánovat → realizovat → uzavřít', async () => {
    const created = await ctx.client.post('/api/changes', need());
    const id = created.body.id;

    const submitted = await ctx.client.post(`/api/changes/${id}/submit`, {});
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.status, 'Ke schválení');

    const approved = await ctx.client.post(`/api/changes/${id}/approve`, {});
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'Schváleno');

    const scheduleNoDate = await ctx.client.post(`/api/changes/${id}/schedule`, {});
    assert.equal(scheduleNoDate.status, 400);

    const scheduled = await ctx.client.post(`/api/changes/${id}/schedule`, { planned_date: '2026-09-01' });
    assert.equal(scheduled.status, 200);
    assert.equal(scheduled.body.status, 'Naplánováno');
    assert.equal(scheduled.body.planned_date, '2026-09-01');

    const implemented = await ctx.client.post(`/api/changes/${id}/implement`, {});
    assert.equal(implemented.status, 200);
    assert.equal(implemented.body.status, 'Realizováno');
    assert.ok(implemented.body.implemented_date);

    const closed = await ctx.client.post(`/api/changes/${id}/close`, {});
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, 'Uzavřeno');

    const assignAfterClose = await ctx.client.post(`/api/changes/${id}/assign`, { user_id: editorId });
    assert.equal(assignAfterClose.status, 409);

    const activity = await ctx.client.get(`/api/changes/${id}/activity`);
    assert.equal(activity.status, 200);
    assert.deepEqual(activity.body.map((a) => a.type),
      ['status_change', 'status_change', 'status_change', 'status_change', 'status_change']);
  });

  test('zamítnutí vyžaduje důvod, znovuotevření vyčistí plánovaný/skutečný termín', async () => {
    const created = await ctx.client.post('/api/changes', need());
    const id = created.body.id;
    await ctx.client.post(`/api/changes/${id}/submit`, {});

    const rejectNoReason = await ctx.client.post(`/api/changes/${id}/reject`, {});
    assert.equal(rejectNoReason.status, 400);

    const rejected = await ctx.client.post(`/api/changes/${id}/reject`, { reason: 'Chybí zpětný plán' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, 'Zamítnuto');

    const reopenNoReason = await ctx.client.post(`/api/changes/${id}/reopen`, {});
    assert.equal(reopenNoReason.status, 400);

    const reopened = await ctx.client.post(`/api/changes/${id}/reopen`, { reason: 'Doplněn zpětný plán' });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.status, 'Návrh');
    assert.equal(reopened.body.planned_date, null);
    assert.equal(reopened.body.implemented_date, null);
  });

  test('přeřazení jinému realizátorovi neruší dosavadní stav', async () => {
    const created = await ctx.client.post('/api/changes', need());
    const id = created.body.id;
    await ctx.client.post(`/api/changes/${id}/assign`, { user_id: editorId });
    await ctx.client.post(`/api/changes/${id}/submit`, {});

    const reassigned = await ctx.client.post(`/api/changes/${id}/assign`, { user_id: editor2Id });
    assert.equal(reassigned.status, 200);
    assert.equal(reassigned.body.status, 'Ke schválení');
    assert.equal(reassigned.body.assigned_to_user_id, editor2Id);
  });

  test('komentář se objeví v časové ose bez změny stavu', async () => {
    const created = await ctx.client.post('/api/changes', need());
    const id = created.body.id;
    const commentNoText = await ctx.client.post(`/api/changes/${id}/comments`, {});
    assert.equal(commentNoText.status, 400);

    const comment = await ctx.client.post(`/api/changes/${id}/comments`, { text: 'Domluveno okno na sobotu' });
    assert.equal(comment.status, 201);
    assert.equal(comment.body.type, 'comment');

    const activity = await ctx.client.get(`/api/changes/${id}/activity`);
    assert.equal(activity.body.length, 1);
    assert.equal(activity.body[0].note, 'Domluveno okno na sobotu');
  });

  test('reader nesmí provádět workflow akce (403)', async () => {
    const created = await ctx.client.post('/api/changes', need());
    const id = created.body.id;
    await ctx.client.login('ctenar', 'Heslo.123');
    const res = await ctx.client.post(`/api/changes/${id}/assign`, { user_id: editorId });
    assert.equal(res.status, 403);
    await ctx.client.login('editor', 'Heslo.123');
  });
});
