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
    assert.equal(res.body.assigned_to_user_id, null);
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

  test('GET /api/incidents/:id vrací jeden incident, neexistující 404', async () => {
    const created = await ctx.client.post('/api/incidents', need());
    const found = await ctx.client.get(`/api/incidents/${created.body.id}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.id, created.body.id);
    const missing = await ctx.client.get('/api/incidents/INC-999');
    assert.equal(missing.status, 404);
  });

  test('PUT upraví popisná pole, ale ne stav (ten je jen přes workflow akce)', async () => {
    const created = await ctx.client.post('/api/incidents', need());
    const res = await ctx.client.put(`/api/incidents/${created.body.id}`, { title: 'Upravený název', status: 'Vyřešeno' });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Upravený název');
    assert.equal(res.body.status, 'Nové'); // status v těle PUT se ignoruje
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

    await ctx.client.login('editor', 'Heslo.123');
  });
});

describe('workflow incidentu: přiřazení a přechody stavu', () => {
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
    title: 'Výpadek VPN', category: 'Dostupnost/výpadek', priority: 'Střední',
    reported_by: 'IT', owner: 'IT oddělení', occurred_at: '2026-08-01',
  });

  test('přiřazení řešiteli z Nové přejde na Přiřazeno', async () => {
    const created = await ctx.client.post('/api/incidents', need());
    const res = await ctx.client.post(`/api/incidents/${created.body.id}/assign`, { user_id: editorId });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'Přiřazeno');
    assert.equal(res.body.assigned_to_user_id, editorId);
  });

  test('neplatný/neaktivní uživatel při přiřazení vrací 400', async () => {
    const created = await ctx.client.post('/api/incidents', need());
    const res = await ctx.client.post(`/api/incidents/${created.body.id}/assign`, { user_id: 999999 });
    assert.equal(res.status, 400);
  });

  test('start ze stavu Nové (bez přiřazení) vrací 409', async () => {
    const created = await ctx.client.post('/api/incidents', need());
    const res = await ctx.client.post(`/api/incidents/${created.body.id}/start`, {});
    assert.equal(res.status, 409);
  });

  test('plný životní cyklus: přiřadit → začít → pozastavit → obnovit → vyřešit → uzavřít', async () => {
    const created = await ctx.client.post('/api/incidents', need());
    const id = created.body.id;

    await ctx.client.post(`/api/incidents/${id}/assign`, { user_id: editorId });
    const started = await ctx.client.post(`/api/incidents/${id}/start`, {});
    assert.equal(started.status, 200);
    assert.equal(started.body.status, 'V řešení');

    const pauseNoReason = await ctx.client.post(`/api/incidents/${id}/pause`, {});
    assert.equal(pauseNoReason.status, 400);

    const paused = await ctx.client.post(`/api/incidents/${id}/pause`, { reason: 'Čeká se na dodavatele' });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, 'Pozastaveno');

    const resumed = await ctx.client.post(`/api/incidents/${id}/resume`, {});
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.status, 'V řešení');

    const resolveNoText = await ctx.client.post(`/api/incidents/${id}/resolve`, {});
    assert.equal(resolveNoText.status, 400);

    const resolved = await ctx.client.post(`/api/incidents/${id}/resolve`, { resolution: 'Restart VPN serveru' });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.status, 'Vyřešeno');
    assert.equal(resolved.body.resolution, 'Restart VPN serveru');
    assert.ok(resolved.body.resolved_at);

    const closed = await ctx.client.post(`/api/incidents/${id}/close`, {});
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, 'Uzavřeno');

    const assignAfterClose = await ctx.client.post(`/api/incidents/${id}/assign`, { user_id: editorId });
    assert.equal(assignAfterClose.status, 409);

    const activity = await ctx.client.get(`/api/incidents/${id}/activity`);
    assert.equal(activity.status, 200);
    assert.deepEqual(activity.body.map((a) => a.type),
      ['assignment', 'status_change', 'status_change', 'status_change', 'status_change', 'status_change']);
  });

  test('eskalace z V řešení, znovuotevření vyčistí resolution/resolved_at', async () => {
    const created = await ctx.client.post('/api/incidents', need());
    const id = created.body.id;
    await ctx.client.post(`/api/incidents/${id}/assign`, { user_id: editorId });
    await ctx.client.post(`/api/incidents/${id}/start`, {});

    const escalated = await ctx.client.post(`/api/incidents/${id}/escalate`, { note: 'Dopad na víc uživatelů' });
    assert.equal(escalated.status, 200);
    assert.equal(escalated.body.status, 'Eskalováno');

    const resolved = await ctx.client.post(`/api/incidents/${id}/resolve`, { resolution: 'Dočasné řešení nasazeno' });
    assert.equal(resolved.status, 200);

    const reopenNoReason = await ctx.client.post(`/api/incidents/${id}/reopen`, {});
    assert.equal(reopenNoReason.status, 400);

    const reopened = await ctx.client.post(`/api/incidents/${id}/reopen`, { reason: 'Problém se vrátil' });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.status, 'V řešení');
    assert.equal(reopened.body.resolution, null);
    assert.equal(reopened.body.resolved_at, null);
  });

  test('přeřazení jinému řešiteli během V řešení nemění stav', async () => {
    const created = await ctx.client.post('/api/incidents', need());
    const id = created.body.id;
    await ctx.client.post(`/api/incidents/${id}/assign`, { user_id: editorId });
    await ctx.client.post(`/api/incidents/${id}/start`, {});

    const reassigned = await ctx.client.post(`/api/incidents/${id}/assign`, { user_id: editor2Id });
    assert.equal(reassigned.status, 200);
    assert.equal(reassigned.body.status, 'V řešení');
    assert.equal(reassigned.body.assigned_to_user_id, editor2Id);
  });

  test('komentář se objeví v časové ose bez změny stavu', async () => {
    const created = await ctx.client.post('/api/incidents', need());
    const id = created.body.id;
    const commentNoText = await ctx.client.post(`/api/incidents/${id}/comments`, {});
    assert.equal(commentNoText.status, 400);

    const comment = await ctx.client.post(`/api/incidents/${id}/comments`, { text: 'Kontaktován dodavatel' });
    assert.equal(comment.status, 201);
    assert.equal(comment.body.type, 'comment');

    const activity = await ctx.client.get(`/api/incidents/${id}/activity`);
    assert.equal(activity.body.length, 1);
    assert.equal(activity.body[0].note, 'Kontaktován dodavatel');

    const unchanged = await ctx.client.get(`/api/incidents/${id}`);
    assert.equal(unchanged.body.status, 'Nové');
  });

  test('reader nesmí provádět workflow akce (403)', async () => {
    const created = await ctx.client.post('/api/incidents', need());
    const id = created.body.id;
    await ctx.client.login('ctenar', 'Heslo.123');
    const res = await ctx.client.post(`/api/incidents/${id}/assign`, { user_id: editorId });
    assert.equal(res.status, 403);
    await ctx.client.login('editor', 'Heslo.123');
  });

  test('GET /api/users/assignable dostupné i pro readera, jen aktivní uživatelé bez citlivých polí', async () => {
    await ctx.client.login('ctenar', 'Heslo.123');
    const res = await ctx.client.get('/api/users/assignable');
    assert.equal(res.status, 200);
    assert.ok(res.body.some((u) => u.name === 'Editor'));
    assert.deepEqual(Object.keys(res.body[0]).sort(), ['id', 'name']);
    await ctx.client.login('editor', 'Heslo.123');
  });
});
