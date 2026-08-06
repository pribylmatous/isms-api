// Vlastní ISMS_UPLOADS musí být nastavený PŘED prvním importem src/storage.js
// (transitivně přes helpers.js → app.js → routes.js), jinak by testy zapisovaly
// do skutečné uploads/ složky vývojového serveru. Statické importy se v ESM
// vždy vyhodnotí (hoistují) před tělem tohoto souboru bez ohledu na pořadí
// v kódu — proto helpers.js načítáme až dynamickým importem, PO nastavení env.
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const uploadDir = mkdtempSync(path.join(os.tmpdir(), 'isms-test-uploads-'));
process.env.ISMS_UPLOADS = uploadDir;

const { startTestServer, createUser } = await import('./helpers.js');

describe('knihovna dokumentů — ukládání souborů', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
    await createUser(ctx.db, { username: 'editor', name: 'Editor', role: 'editor', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'manazer', name: 'Manažerka', role: 'manager', password: 'Heslo.123' });
    await ctx.client.login('editor', 'Heslo.123');
  });

  after(async () => {
    await ctx.close();
    rmSync(uploadDir, { recursive: true, force: true });
  });

  const filesOnDisk = () => readdirSync(uploadDir);

  test('vytvoření dokumentu bez souboru', async () => {
    const res = await ctx.client.post('/api/policies', {
      name: 'Politika bez souboru', category: 'Postupy', owner: 'SOC tým',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.file_name, null);
    assert.equal(filesOnDisk().length, 0);
  });

  test('nahrání dokumentu se souborem uloží soubor na disk a metadata do DB', async () => {
    const fd = new FormData();
    fd.set('name', 'Politika zálohování');
    fd.set('category', 'Řídicí dokumentace');
    fd.set('owner', 'J. Kovářová');
    fd.set('file', new Blob(['obsah testovacího dokumentu'], { type: 'application/pdf' }), 'zaloha.pdf');

    const res = await ctx.client.post('/api/policies', fd);
    assert.equal(res.status, 201);
    assert.equal(res.body.file_name, 'zaloha.pdf');
    assert.equal(res.body.file_size, Buffer.byteLength('obsah testovacího dokumentu', 'utf8'));

    const row = await ctx.db.prepare('SELECT file_stored FROM policies WHERE id = ?').get(res.body.id);
    assert.ok(row.file_stored, 'file_stored by mělo být nastavené');
    assert.ok(existsSync(path.join(uploadDir, row.file_stored)), 'soubor by měl existovat na disku');

    const download = await ctx.client.get(`/api/policies/${res.body.id}/file`);
    assert.equal(download.status, 200);
    assert.equal(download.body, 'obsah testovacího dokumentu');
  });

  test('nahrazení souboru smaže starý soubor z disku', async () => {
    const fd1 = new FormData();
    fd1.set('name', 'Dokument k nahrazení');
    fd1.set('category', 'Postupy');
    fd1.set('owner', 'SOC tým');
    fd1.set('file', new Blob(['verze 1'], { type: 'application/pdf' }), 'v1.pdf');
    const created = await ctx.client.post('/api/policies', fd1);
    const oldStored = (await ctx.db.prepare('SELECT file_stored FROM policies WHERE id = ?').get(created.body.id)).file_stored;
    assert.ok(existsSync(path.join(uploadDir, oldStored)));

    const fd2 = new FormData();
    fd2.set('name', 'Dokument k nahrazení');
    fd2.set('category', 'Postupy');
    fd2.set('owner', 'SOC tým');
    fd2.set('version', '2.0');
    fd2.set('status', 'Návrh');
    fd2.set('file', new Blob(['verze 2'], { type: 'application/pdf' }), 'v2.pdf');
    const updated = await ctx.client.put(`/api/policies/${created.body.id}`, fd2);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.file_name, 'v2.pdf');

    assert.equal(existsSync(path.join(uploadDir, oldStored)), false, 'starý soubor by měl být smazaný');
    const newStored = (await ctx.db.prepare('SELECT file_stored FROM policies WHERE id = ?').get(created.body.id)).file_stored;
    assert.ok(existsSync(path.join(uploadDir, newStored)));
  });

  test('úprava metadat bez nového souboru ponechá existující soubor', async () => {
    const fd = new FormData();
    fd.set('name', 'Stabilní dokument');
    fd.set('category', 'Postupy');
    fd.set('owner', 'SOC tým');
    fd.set('file', new Blob(['obsah'], { type: 'application/pdf' }), 'stabilni.pdf');
    const created = await ctx.client.post('/api/policies', fd);

    // Formulář pro úpravu odesílá i prázdné <input type="file"> pole
    const fdEdit = new FormData();
    fdEdit.set('name', 'Stabilní dokument (upraveno)');
    fdEdit.set('category', 'Postupy');
    fdEdit.set('owner', 'SOC tým');
    fdEdit.set('version', '1.0');
    fdEdit.set('status', 'Návrh');
    fdEdit.set('file', new Blob([], { type: 'application/octet-stream' }), '');
    const updated = await ctx.client.put(`/api/policies/${created.body.id}`, fdEdit);

    assert.equal(updated.status, 200);
    assert.equal(updated.body.file_name, 'stabilni.pdf');
    assert.equal(updated.body.name, 'Stabilní dokument (upraveno)');
  });

  test('smazání dokumentu smaže i soubor z disku', async () => {
    const fd = new FormData();
    fd.set('name', 'Dokument ke smazání');
    fd.set('category', 'Postupy');
    fd.set('owner', 'SOC tým');
    fd.set('file', new Blob(['ke smazání'], { type: 'application/pdf' }), 'smazat.pdf');
    const created = await ctx.client.post('/api/policies', fd);
    const stored = (await ctx.db.prepare('SELECT file_stored FROM policies WHERE id = ?').get(created.body.id)).file_stored;

    await ctx.client.login('manazer', 'Heslo.123'); // DELETE vyžaduje roli manager
    const del = await ctx.client.del(`/api/policies/${created.body.id}`);
    assert.equal(del.status, 204);
    assert.equal(existsSync(path.join(uploadDir, stored)), false);
    await ctx.client.login('editor', 'Heslo.123');
  });

  test('nepovolená přípona souboru se odmítne s 400 a nevytvoří záznam', async () => {
    const before_ = filesOnDisk().length;
    const fd = new FormData();
    fd.set('name', 'Škodlivý soubor');
    fd.set('category', 'Postupy');
    fd.set('owner', 'SOC tým');
    fd.set('file', new Blob(['x'], { type: 'application/octet-stream' }), 'malware.exe');
    const res = await ctx.client.post('/api/policies', fd);
    assert.equal(res.status, 400);
    assert.equal(filesOnDisk().length, before_);
    const row = await ctx.db.prepare("SELECT * FROM policies WHERE name = 'Škodlivý soubor'").get();
    assert.equal(row, undefined);
  });
});
