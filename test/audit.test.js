import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { diffRows } from '../src/audit.js';
import { startTestServer, createUser } from './helpers.js';

describe('diffRows (čistá funkce)', () => {
  test('vrací jen pole, která se liší', () => {
    const before = { id: 1, name: 'A', owner: 'X', updated_at: 't1' };
    const afterRow = { id: 1, name: 'B', owner: 'X', updated_at: 't2' };
    assert.deepEqual(diffRows(before, afterRow), { name: ['A', 'B'] });
  });

  test('ignoruje interní pole (updated_at, created_at, file_stored)', () => {
    const before = { updated_at: 't1', created_at: 'c1', file_stored: 'a.pdf' };
    const afterRow = { updated_at: 't2', created_at: 'c1', file_stored: 'b.pdf' };
    assert.deepEqual(diffRows(before, afterRow), {});
  });

  test('null before/after se bere jako prázdný objekt', () => {
    assert.deepEqual(diffRows(null, { name: 'X' }), { name: [null, 'X'] });
    assert.deepEqual(diffRows({ name: 'X' }, null), { name: ['X', null] });
  });
});

describe('auditní stopa — API', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
    await createUser(ctx.db, { username: 'editor', name: 'Editor', role: 'editor', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'manazer', name: 'Manažerka', role: 'manager', password: 'Heslo.123' });
  });

  after(() => ctx.close());

  test('GET /api/audit-log vyžaduje roli manager', async () => {
    await ctx.client.login('editor', 'Heslo.123');
    const res = await ctx.client.get('/api/audit-log');
    assert.equal(res.status, 403);
  });

  test('vytvoření rizika zapíše záznam s action=create a bez changes', async () => {
    await ctx.client.login('editor', 'Heslo.123');
    const created = await ctx.client.post('/api/risks', {
      name: 'Riziko pro audit', asset: 'Aktivum', probability: 2, impact: 2, owner: 'J. Kovářová',
    });

    await ctx.client.login('manazer', 'Heslo.123');
    const log = await ctx.client.get(`/api/audit-log?entity=risk&entityId=${created.body.id}`);
    assert.equal(log.status, 200);
    assert.equal(log.body.length, 1);
    assert.equal(log.body[0].action, 'create');
    assert.equal(log.body[0].user_name, 'Editor');
    assert.equal(log.body[0].label, 'Riziko pro audit');
    assert.equal(log.body[0].changes, null);
  });

  test('úprava rizika zapíše diff jen změněných polí', async () => {
    await ctx.client.login('editor', 'Heslo.123');
    const created = await ctx.client.post('/api/risks', {
      name: 'Riziko k úpravě', asset: 'Aktivum', probability: 1, impact: 1, owner: 'P. Dvořák',
    });
    await ctx.client.put(`/api/risks/${created.body.id}`, { owner: 'SOC tým' });

    await ctx.client.login('manazer', 'Heslo.123');
    const log = await ctx.client.get(`/api/audit-log?entity=risk&entityId=${created.body.id}`);
    const updateEntry = log.body.find((e) => e.action === 'update');
    assert.ok(updateEntry, 'měl by existovat záznam o úpravě');
    assert.deepEqual(updateEntry.changes.owner, ['P. Dvořák', 'SOC tým']);
    assert.ok(!('name' in updateEntry.changes), 'nezměněné pole by nemělo být v diffu');
  });

  test('úprava beze změny hodnot nevytvoří záznam', async () => {
    await ctx.client.login('editor', 'Heslo.123');
    const created = await ctx.client.post('/api/risks', {
      name: 'Riziko beze změny', asset: 'Aktivum', probability: 1, impact: 1, owner: 'SOC tým',
    });
    await ctx.client.put(`/api/risks/${created.body.id}`, { owner: 'SOC tým' }); // stejná hodnota

    await ctx.client.login('manazer', 'Heslo.123');
    const log = await ctx.client.get(`/api/audit-log?entity=risk&entityId=${created.body.id}`);
    assert.equal(log.body.filter((e) => e.action === 'update').length, 0);
  });

  test('smazání rizika zapíše action=delete', async () => {
    await ctx.client.login('editor', 'Heslo.123');
    const created = await ctx.client.post('/api/risks', {
      name: 'Riziko ke smazání pro audit', asset: 'Aktivum', probability: 1, impact: 1, owner: 'SOC tým',
    });
    await ctx.client.login('manazer', 'Heslo.123');
    await ctx.client.del(`/api/risks/${created.body.id}`);

    const log = await ctx.client.get(`/api/audit-log?entity=risk&entityId=${created.body.id}`);
    assert.ok(log.body.some((e) => e.action === 'delete'));
  });

  test('filtr podle entity vrací jen odpovídající typ', async () => {
    await ctx.client.login('editor', 'Heslo.123');
    await ctx.client.post('/api/findings', {
      finding: 'Testovací zjištění pro audit', type: 'Pozorování', due: '2026-12-31', owner: 'SOC tým',
    });

    await ctx.client.login('manazer', 'Heslo.123');
    const log = await ctx.client.get('/api/audit-log?entity=finding');
    assert.ok(log.body.length > 0);
    assert.ok(log.body.every((e) => e.entity === 'finding'));
  });
});
