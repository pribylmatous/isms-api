import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createUser } from './helpers.js';

const QUIZ = [
  { q: 'Otázka 1', options: ['Špatně', 'Správně'], correct: 1 },
  { q: 'Otázka 2', options: ['Správně', 'Špatně'], correct: 0 },
];

describe('interaktivní školení (kvíz)', () => {
  let ctx;
  let quizTrainingId;
  let staticTrainingId;

  before(async () => {
    ctx = await startTestServer();
    await createUser(ctx.db, { username: 'alice', name: 'Alice', role: 'reader', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'bob', name: 'Bob', role: 'reader', password: 'Heslo.123' });

    quizTrainingId = (await ctx.db.prepare(
      'INSERT INTO trainings (name, audience, due, pct, content) VALUES (?, ?, ?, ?, ?) RETURNING id',
    ).get('Testovací kvíz', 'Uživatelé portálu', '2026-12-31', 0, JSON.stringify(QUIZ))).id;

    staticTrainingId = (await ctx.db.prepare(
      'INSERT INTO trainings (name, audience, due, pct) VALUES (?, ?, ?, ?) RETURNING id',
    ).get('Statické školení', 'Všichni', '2026-12-31', 42)).id;

    await ctx.client.login('alice', 'Heslo.123');
  });

  after(() => ctx.close());

  test('GET .../quiz vrací otázky bez správných odpovědí', async () => {
    const res = await ctx.client.get(`/api/trainings/${quizTrainingId}/quiz`);
    assert.equal(res.status, 200);
    assert.equal(res.body.questions.length, 2);
    for (const q of res.body.questions) assert.ok(!('correct' in q));
  });

  test('GET .../quiz na školení bez obsahu vrací 404', async () => {
    const res = await ctx.client.get(`/api/trainings/${staticTrainingId}/quiz`);
    assert.equal(res.status, 404);
  });

  test('statické školení má hasQuiz=false a uloženou pct hodnotu', async () => {
    const list = await ctx.client.get('/api/trainings');
    const found = list.body.find((t) => t.id === staticTrainingId);
    assert.equal(found.hasQuiz, false);
    assert.equal(found.pct, 42);
    assert.equal(found.myCompletion, null);
  });

  test('špatný počet odpovědí vrací 400', async () => {
    const res = await ctx.client.post(`/api/trainings/${quizTrainingId}/complete`, { answers: [1] });
    assert.equal(res.status, 400);
  });

  test('správné odpovědi → 100 %, passed, a projeví se v myCompletion', async () => {
    const res = await ctx.client.post(`/api/trainings/${quizTrainingId}/complete`, { answers: [1, 0] });
    assert.equal(res.status, 200);
    assert.equal(res.body.score, 100);
    assert.equal(res.body.passed, true);

    const list = await ctx.client.get('/api/trainings');
    const found = list.body.find((t) => t.id === quizTrainingId);
    assert.equal(found.myCompletion.score, 100);
    assert.equal(found.myCompletion.passed, true);
  });

  test('pct se počítá živě z počtu uživatelů, kteří prošli (ne z pevné hodnoty)', async () => {
    // alice prošla (výše), bob zatím ne → z 2 uživatelů 1 prošel = 50 %
    const list = await ctx.client.get('/api/trainings');
    const found = list.body.find((t) => t.id === quizTrainingId);
    assert.equal(found.pct, 50);
  });

  test('opakování přepíše skóre (upsert), nevytvoří duplicitní záznam', async () => {
    await ctx.client.post(`/api/trainings/${quizTrainingId}/complete`, { answers: [0, 0] }); // teď špatně
    const rows = await ctx.db.prepare('SELECT * FROM training_completions WHERE training_id = ? AND user_id = (SELECT id FROM users WHERE username = ?)')
      .all(quizTrainingId, 'alice');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].score, 50);
    assert.equal(rows[0].passed, 0);
  });

  test('druhý uživatel má nezávislý výsledek', async () => {
    await ctx.client.login('bob', 'Heslo.123');
    const res = await ctx.client.post(`/api/trainings/${quizTrainingId}/complete`, { answers: [1, 0] });
    assert.equal(res.body.score, 100);

    const list = await ctx.client.get('/api/trainings');
    const found = list.body.find((t) => t.id === quizTrainingId);
    assert.equal(found.myCompletion.score, 100); // bobův výsledek, ne alicin
    assert.equal(found.pct, 50); // alice (nesplněno po opakování) + bob (splněno) z 2 uživatelů
  });
});

describe('administrace školení (jen manažer)', () => {
  let ctx;

  const validQuestions = () => [
    { q: 'Otázka A', options: ['Ne', 'Ano'], correct: 1 },
    { q: 'Otázka B', options: ['Ano', 'Ne'], correct: 0 },
  ];
  const ALL_ROLES = ['reader', 'editor', 'manager'];

  before(async () => {
    ctx = await startTestServer();
    await createUser(ctx.db, { username: 'reader', name: 'Čtenář', role: 'reader', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'editor', name: 'Editor', role: 'editor', password: 'Heslo.123' });
    await createUser(ctx.db, { username: 'manager', name: 'Manažerka', role: 'manager', password: 'Heslo.123' });
  });

  after(() => ctx.close());

  test('reader ani editor nesmí vytvořit školení (403)', async () => {
    await ctx.client.login('reader', 'Heslo.123');
    const asReader = await ctx.client.post('/api/trainings', { name: 'X', target_roles: ALL_ROLES, due: '2026-12-31', questions: validQuestions() });
    assert.equal(asReader.status, 403);

    await ctx.client.login('editor', 'Heslo.123');
    const asEditor = await ctx.client.post('/api/trainings', { name: 'X', target_roles: ALL_ROLES, due: '2026-12-31', questions: validQuestions() });
    assert.equal(asEditor.status, 403);
  });

  test('manažer vytvoří školení s kvízem pro všechny role', async () => {
    await ctx.client.login('manager', 'Heslo.123');
    const res = await ctx.client.post('/api/trainings', {
      name: 'Nové školení', target_roles: ALL_ROLES, due: '2026-12-31', questions: validQuestions(),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.hasQuiz, true);
    assert.equal(res.body.pct, 0);
    assert.equal(res.body.audience, 'Všichni uživatelé');
  });

  test('prázdný seznam otázek vrací 400', async () => {
    const res = await ctx.client.post('/api/trainings', { name: 'X', target_roles: ALL_ROLES, due: '2026-12-31', questions: [] });
    assert.equal(res.status, 400);
  });

  test('chybějící target_roles vrací 400', async () => {
    const res = await ctx.client.post('/api/trainings', { name: 'X', due: '2026-12-31', questions: validQuestions() });
    assert.equal(res.status, 400);
  });

  test('neplatná role v target_roles vrací 400', async () => {
    const res = await ctx.client.post('/api/trainings', {
      name: 'X', target_roles: ['superadmin'], due: '2026-12-31', questions: validQuestions(),
    });
    assert.equal(res.status, 400);
  });

  test('otázka s neplatným indexem správné odpovědi vrací 400', async () => {
    const res = await ctx.client.post('/api/trainings', {
      name: 'X', target_roles: ALL_ROLES, due: '2026-12-31',
      questions: [{ q: 'Otázka', options: ['A', 'B'], correct: 5 }],
    });
    assert.equal(res.status, 400);
  });

  test('otázka s méně než dvěma možnostmi vrací 400', async () => {
    const res = await ctx.client.post('/api/trainings', {
      name: 'X', target_roles: ALL_ROLES, due: '2026-12-31',
      questions: [{ q: 'Otázka', options: ['Jen jedna'], correct: 0 }],
    });
    assert.equal(res.status, 400);
  });

  test('GET /api/trainings/:id vrací plný obsah vč. správných odpovědí (jen manažer)', async () => {
    const created = await ctx.client.post('/api/trainings', {
      name: 'Pro editaci', target_roles: ALL_ROLES, due: '2026-12-31', questions: validQuestions(),
    });
    const full = await ctx.client.get(`/api/trainings/${created.body.id}`);
    assert.equal(full.status, 200);
    assert.equal(full.body.questions[0].correct, 1);
    assert.deepEqual(full.body.targetRoles, ALL_ROLES);

    await ctx.client.login('reader', 'Heslo.123');
    const denied = await ctx.client.get(`/api/trainings/${created.body.id}`);
    assert.equal(denied.status, 403);
    await ctx.client.login('manager', 'Heslo.123');
  });

  test('manažer upraví název, otázky a cílovou skupinu existujícího školení', async () => {
    const created = await ctx.client.post('/api/trainings', {
      name: 'Ke změně', target_roles: ALL_ROLES, due: '2026-12-31', questions: validQuestions(),
    });
    const updated = await ctx.client.put(`/api/trainings/${created.body.id}`, {
      name: 'Přejmenováno', target_roles: ['manager'], questions: [{ q: 'Nová otázka', options: ['X', 'Y'], correct: 0 }],
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Přejmenováno');
    assert.equal(updated.body.audience, 'Manažeři');

    const quiz = await ctx.client.get(`/api/trainings/${created.body.id}/quiz`);
    assert.equal(quiz.body.questions.length, 1);
    assert.equal(quiz.body.questions[0].q, 'Nová otázka');
  });

  test('školení cílené jen na manažery se readerovi nezobrazí a nejde absolvovat (403)', async () => {
    const created = await ctx.client.post('/api/trainings', {
      name: 'Jen pro manažery', target_roles: ['manager'], due: '2026-12-31', questions: validQuestions(),
    });

    await ctx.client.login('reader', 'Heslo.123');
    const list = await ctx.client.get('/api/trainings');
    assert.ok(!list.body.some((t) => t.id === created.body.id), 'reader by neměl vidět školení cílené jen na manažery');

    const quiz = await ctx.client.get(`/api/trainings/${created.body.id}/quiz`);
    assert.equal(quiz.status, 403);
    const complete = await ctx.client.post(`/api/trainings/${created.body.id}/complete`, { answers: [1, 0] });
    assert.equal(complete.status, 403);

    await ctx.client.login('manager', 'Heslo.123');
  });

  test('manažer vidí i školení, které pro jeho roli není cílené (administrace)', async () => {
    const created = await ctx.client.post('/api/trainings', {
      name: 'Jen pro čtenáře', target_roles: ['reader'], due: '2026-12-31', questions: validQuestions(),
    });
    const list = await ctx.client.get('/api/trainings'); // stále přihlášen jako manažer
    assert.ok(list.body.some((t) => t.id === created.body.id));
  });

  test('pct a roster se počítají jen vůči uživatelům v cílové skupině', async () => {
    // z uživatelů z before() je jen jeden reader ('Čtenář') → cíl jen na readery = 1 uživatel
    const created = await ctx.client.post('/api/trainings', {
      name: 'Jen pro čtenáře - pct', target_roles: ['reader'], due: '2026-12-31', questions: validQuestions(),
    });

    await ctx.client.login('reader', 'Heslo.123');
    await ctx.client.post(`/api/trainings/${created.body.id}/complete`, { answers: [1, 0] }); // 100 %

    await ctx.client.login('manager', 'Heslo.123');
    const list = await ctx.client.get('/api/trainings');
    const found = list.body.find((t) => t.id === created.body.id);
    assert.equal(found.pct, 100); // 1 z 1 readera prošel, ne 1 ze 3 všech uživatelů

    const roster = await ctx.client.get(`/api/trainings/${created.body.id}/completions`);
    assert.equal(roster.body.length, 1); // jen readeři, ne editor/manager
    assert.equal(roster.body[0].name, 'Čtenář');
  });

  test('GET .../completions vrací uživatele v cílové skupině (roster)', async () => {
    const created = await ctx.client.post('/api/trainings', {
      name: 'Roster test', target_roles: ALL_ROLES, due: '2026-12-31', questions: validQuestions(),
    });

    await ctx.client.login('reader', 'Heslo.123');
    await ctx.client.post(`/api/trainings/${created.body.id}/complete`, { answers: [1, 0] }); // 100 %

    await ctx.client.login('manager', 'Heslo.123');
    const roster = await ctx.client.get(`/api/trainings/${created.body.id}/completions`);
    assert.equal(roster.status, 200);
    assert.equal(roster.body.length, 3); // reader, editor, manager

    const readerRow = roster.body.find((r) => r.name === 'Čtenář');
    assert.equal(readerRow.score, 100);
    assert.equal(readerRow.passed, true);

    const editorRow = roster.body.find((r) => r.name === 'Editor');
    assert.equal(editorRow.score, null);
    assert.equal(editorRow.passed, null);
    assert.equal(editorRow.completedAt, null);
  });

  test('reader nesmí vidět roster (403)', async () => {
    await ctx.client.login('reader', 'Heslo.123');
    const res = await ctx.client.get('/api/trainings/1/completions');
    assert.equal(res.status, 403);
  });

  test('manažer smaže školení, absolvování zmizí (ON DELETE CASCADE)', async () => {
    await ctx.client.login('manager', 'Heslo.123');
    const created = await ctx.client.post('/api/trainings', {
      name: 'Ke smazání', target_roles: ALL_ROLES, due: '2026-12-31', questions: validQuestions(),
    });
    await ctx.client.post(`/api/trainings/${created.body.id}/complete`, { answers: [1, 0] });

    const del = await ctx.client.del(`/api/trainings/${created.body.id}`);
    assert.equal(del.status, 204);

    const remaining = await ctx.db.prepare('SELECT * FROM training_completions WHERE training_id = ?').all(created.body.id);
    assert.equal(remaining.length, 0);
  });
});
