import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createUser } from './helpers.js';

describe('registr rizik — skóre a notifikace', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
    createUser(ctx.db, {
      username: 'editor', name: 'Editor', role: 'editor', password: 'Heslo.123', email: 'editor@expect-it.cz',
    });
    createUser(ctx.db, {
      username: 'manazer', name: 'Manažerka', role: 'manager', password: 'Heslo.123', email: 'manazer@expect-it.cz',
    });
  });

  after(() => ctx.close());

  beforeEach(async () => {
    await ctx.client.login('editor', 'Heslo.123');
  });

  const notificationsFor = (event) => ctx.db.prepare('SELECT * FROM notifications WHERE event = ? ORDER BY id').all(event);

  test('skóre a úroveň počítá server (pravděpodobnost × dopad)', async () => {
    const res = await ctx.client.post('/api/risks', {
      name: 'Riziko A', asset: 'Aktivum A', probability: 3, impact: 3, owner: 'J. Kovářová',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.score, 9);
    assert.equal(res.body.level, 'Vysoké');
  });

  test('nový vysoký rizikový záznam pošle notifikaci risk.created, ne risk.escalated', async () => {
    const before_ = notificationsFor('risk.created').length;
    await ctx.client.post('/api/risks', {
      name: 'Riziko B', asset: 'Aktivum B', probability: 4, impact: 4, owner: 'M. Novák',
    });
    assert.equal(notificationsFor('risk.created').length, before_ + 1);
    assert.equal(notificationsFor('risk.escalated').length, 0);
  });

  test('eskalace na Vysoké při úpravě pošle risk.escalated, ale jen jednou', async () => {
    const created = await ctx.client.post('/api/risks', {
      name: 'Riziko C', asset: 'Aktivum C', probability: 2, impact: 2, owner: 'P. Dvořák',
    });
    assert.equal(created.body.level, 'Nízké');

    const escalated = await ctx.client.put(`/api/risks/${created.body.id}`, { probability: 4, impact: 4 });
    assert.equal(escalated.body.level, 'Vysoké');
    assert.equal(notificationsFor('risk.escalated').length, 1);

    // Zůstane-li Vysoké, notifikace se znovu neposílá (jen na *přechod* do Vysoké)
    await ctx.client.put(`/api/risks/${created.body.id}`, { probability: 4, impact: 3 });
    assert.equal(notificationsFor('risk.escalated').length, 1);
  });

  test('uzavření rizika pošle risk.closed', async () => {
    const created = await ctx.client.post('/api/risks', {
      name: 'Riziko D', asset: 'Aktivum D', probability: 1, impact: 1, owner: 'SOC tým',
    });
    await ctx.client.put(`/api/risks/${created.body.id}`, { status: 'Uzavřené' });
    assert.equal(notificationsFor('risk.closed').length, 1);
  });

  test('smazání rizika (manažerem) pošle risk.deleted', async () => {
    const created = await ctx.client.post('/api/risks', {
      name: 'Riziko E', asset: 'Aktivum E', probability: 1, impact: 1, owner: 'SOC tým',
    });
    await ctx.client.login('manazer', 'Heslo.123');
    const del = await ctx.client.del(`/api/risks/${created.body.id}`);
    assert.equal(del.status, 204);
    assert.equal(notificationsFor('risk.deleted').length, 1);
  });

  test('chybějící povinné pole vrací 400', async () => {
    const res = await ctx.client.post('/api/risks', { name: 'Bez aktiva', probability: 1, impact: 1, owner: 'X' });
    assert.equal(res.status, 400);
  });

  test('pravděpodobnost mimo rozsah 1–4 vrací 400', async () => {
    const res = await ctx.client.post('/api/risks', {
      name: 'Mimo rozsah', asset: 'A', probability: 5, impact: 1, owner: 'X',
    });
    assert.equal(res.status, 400);
  });
});
