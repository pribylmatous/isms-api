// REST API ISMS portálu. Datumy v ISO 8601, texty v UTF-8.
// Důležité akce vytvářejí e-mailové notifikace (viz notify.js).

import ExcelJS from 'exceljs';
import { OWNERS } from './lov.js';
import { UPLOAD_DIR, uploadDocument, pickedFile, saveFile, deleteFile } from './storage.js';
import { levelOf, domainCompliance } from './scoring.js';
import { hashPassword } from './auth.js';

const POLICY_COLUMNS = 'id, name, category, version, owner, status, updated_at, file_name, file_size, file_mime';
const TRAINING_PASS_THRESHOLD = 75; // % správných odpovědí pro absolvování kvízu

const httpError = (status, message) => Object.assign(new Error(message), { status });

const need = (body, ...fields) => {
  for (const f of fields) {
    if (body?.[f] == null || String(body[f]).trim() === '') {
      throw httpError(400, `Chybí povinné pole: ${f}`);
    }
  }
};

const intInRange = (value, min, max, name) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw httpError(400, `Pole ${name} musí být celé číslo ${min}–${max}`);
  }
  return n;
};

// Ověří volitelnou vazbu na jinou entitu (opatření/riziko) — prázdná hodnota = žádná vazba.
const assertRef = async (db, table, id, label) => {
  if (id == null || id === '') return null;
  if (!(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id))) {
    throw httpError(400, `Neplatné ${label}: ${id}`);
  }
  return id;
};

// 'R' → 'R-09' podle nejvyššího existujícího čísla v tabulce
const nextId = async (db, table, prefix) => {
  const rows = await db.prepare(`SELECT id FROM ${table}`).all();
  const max = rows.reduce((m, r) => {
    const n = parseInt(String(r.id).split('-')[1], 10);
    return Number.isNaN(n) ? m : Math.max(m, n);
  }, 0);
  return `${prefix}-${String(max + 1).padStart(2, '0')}`;
};

// Přirozené řazení ID opatření: 'A.5.2' < 'A.5.10' (textové řazení by selhalo)
const controlOrder = (id) => {
  const [, major, minor] = String(id).split('.');
  return Number(major) * 1000 + Number(minor);
};
const sortControls = (rows) => rows.sort((a, b) => controlOrder(a.id) - controlOrder(b.id));

export function registerRoutes(app, db, requireRole, notifier, audit) {
  const canWrite = requireRole('editor', 'manager');
  const canDelete = requireRole('manager');
  const by = (req) => `Provedl(a): ${req.user.name}`;

  // ---------- Opatření přílohy A ----------

  app.get('/api/controls', async (req, res) => {
    res.json(sortControls(await db.prepare('SELECT * FROM controls').all()));
  });

  // Předdefinovaný číselník vlastníků (LOV) pro formulář
  app.get('/api/controls/owners', (req, res) => {
    res.json(OWNERS);
  });

  app.put('/api/controls/:id', canWrite, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM controls WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Opatření nenalezeno');
    const c = { ...existing, ...pick(req.body, ['status', 'owner', 'review_due']) };
    await db.prepare('UPDATE controls SET status = ?, owner = ?, review_due = ?, updated_at = ? WHERE id = ?')
      .run(c.status, c.owner, c.review_due, new Date().toISOString(), req.params.id);
    if (c.status !== existing.status) {
      await notifier.notify('control.status', `Změna stavu opatření ${c.id}: ${c.status}`, [
        `Opatření: ${c.id} ${existing.name} (${existing.domain})`,
        `Stav: ${existing.status} → ${c.status}`,
        `Odpovědná osoba: ${c.owner}`,
        by(req),
      ]);
    }
    const updated = await db.prepare('SELECT * FROM controls WHERE id = ?').get(req.params.id);
    await audit.record(req, { entity: 'control', entityId: updated.id, action: 'update', before: existing, after: updated, label: updated.name });
    res.json(updated);
  });

  // Export SoA (XLSX pro Excel). Sloupec "Odpovědná osoba" má datovou validaci
  // (rozbalovací seznam) na stejný číselník vlastníků jako formuláře v portálu.
  app.get('/api/controls/export.xlsx', async (req, res) => {
    const rows = sortControls(await db.prepare('SELECT id, name, domain, status, owner FROM controls').all());

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('SoA');
    sheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Opatření', key: 'name', width: 50 },
      { header: 'Doména', key: 'domain', width: 20 },
      { header: 'Stav', key: 'status', width: 20 },
      { header: 'Odpovědná osoba', key: 'owner', width: 24 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const r of rows) sheet.addRow(r);

    const ownerList = `"${OWNERS.join(',')}"`;
    for (let i = 0; i < rows.length; i++) {
      sheet.getCell(`E${i + 2}`).dataValidation = {
        type: 'list',
        allowBlank: false,
        formulae: [ownerList],
        showErrorMessage: true,
        errorTitle: 'Neplatná odpovědná osoba',
        error: 'Vyberte hodnotu ze seznamu.',
      };
    }

    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set(`Content-Disposition`, `attachment; filename="SoA-export-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  });

  // ---------- Registr rizik ----------

  app.get('/api/risks', async (req, res) => {
    res.json(await db.prepare('SELECT * FROM risks ORDER BY id').all());
  });

  // Předdefinovaný číselník vlastníků (LOV) pro formulář
  app.get('/api/risks/owners', (req, res) => {
    res.json(OWNERS);
  });

  app.post('/api/risks', canWrite, async (req, res) => {
    need(req.body, 'name', 'asset', 'probability', 'impact', 'owner');
    const probability = intInRange(req.body.probability, 1, 4, 'probability');
    const impact = intInRange(req.body.impact, 1, 4, 'impact');
    const score = probability * impact;
    const id = await nextId(db, 'risks', 'R');
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO risks (id, name, asset, probability, impact, score, level, owner, treatment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.body.name.trim(), req.body.asset.trim(), probability, impact, score, levelOf(score),
        req.body.owner.trim(), (req.body.treatment ?? '').trim() || null, now, now);
    const risk = await db.prepare('SELECT * FROM risks WHERE id = ?').get(id);
    await notifier.notify('risk.created', `Nové riziko ${id}: ${risk.name}`, [
      `Aktivum: ${risk.asset}`,
      `Skóre: ${risk.score} (${risk.level})`,
      `Vlastník: ${risk.owner}`,
      risk.treatment ? `Ošetření: ${risk.treatment}` : null,
      by(req),
    ]);
    await audit.record(req, { entity: 'risk', entityId: risk.id, action: 'create', after: risk, label: risk.name });
    res.status(201).json(risk);
  });

  app.put('/api/risks/:id', canWrite, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM risks WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Riziko nenalezeno');
    const r = { ...existing, ...pick(req.body, ['name', 'asset', 'probability', 'impact', 'owner', 'treatment', 'status']) };
    if (r.probability != null && r.impact != null) {
      r.probability = intInRange(r.probability, 1, 4, 'probability');
      r.impact = intInRange(r.impact, 1, 4, 'impact');
      r.score = r.probability * r.impact;
      r.level = levelOf(r.score);
    }
    await db.prepare(`UPDATE risks SET name = ?, asset = ?, probability = ?, impact = ?, score = ?, level = ?,
                owner = ?, treatment = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(r.name, r.asset, r.probability, r.impact, r.score, r.level, r.owner, r.treatment, r.status, new Date().toISOString(), req.params.id);
    if (r.level === 'Vysoké' && existing.level !== 'Vysoké') {
      await notifier.notify('risk.escalated', `Riziko ${r.id} eskalováno na Vysoké: ${r.name}`, [
        `Skóre: ${existing.score} → ${r.score}`,
        `Vlastník: ${r.owner}`,
        by(req),
      ]);
    }
    if (r.status === 'Uzavřené' && existing.status !== 'Uzavřené') {
      await notifier.notify('risk.closed', `Riziko ${r.id} uzavřeno: ${r.name}`, [
        `Vlastník: ${r.owner}`,
        by(req),
      ]);
    }
    const updated = await db.prepare('SELECT * FROM risks WHERE id = ?').get(req.params.id);
    await audit.record(req, { entity: 'risk', entityId: updated.id, action: 'update', before: existing, after: updated, label: updated.name });
    res.json(updated);
  });

  app.delete('/api/risks/:id', canDelete, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM risks WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Riziko nenalezeno');
    await db.prepare('DELETE FROM risks WHERE id = ?').run(req.params.id);
    await notifier.notify('risk.deleted', `Riziko ${existing.id} smazáno: ${existing.name}`, [by(req)]);
    await audit.record(req, { entity: 'risk', entityId: existing.id, action: 'delete', before: existing, label: existing.name });
    res.status(204).end();
  });

  // ---------- Knihovna dokumentů ----------

  app.get('/api/policies', async (req, res) => {
    res.json(await db.prepare(`SELECT ${POLICY_COLUMNS} FROM policies ORDER BY id`).all());
  });

  // Předdefinovaný číselník vlastníků (LOV) pro formulář
  app.get('/api/policies/owners', (req, res) => {
    res.json(OWNERS);
  });

  app.post('/api/policies', canWrite, uploadDocument, async (req, res) => {
    need(req.body, 'name', 'category', 'owner');
    const file = pickedFile(req);
    const saved = file ? saveFile(file) : null;
    const policy = await db.prepare(`INSERT INTO policies
      (name, category, version, owner, status, updated_at, file_name, file_stored, file_size, file_mime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${POLICY_COLUMNS}`)
      .get(req.body.name.trim(), req.body.category, req.body.version ?? '1.0',
        req.body.owner.trim(), 'Návrh', new Date().toISOString().slice(0, 10),
        saved?.name ?? null, saved?.stored ?? null, saved?.size ?? null, saved?.mime ?? null);
    await notifier.notify('policy.created', `Nový dokument: ${policy.name}`, [
      `Kategorie: ${policy.category}`,
      `Vlastník: ${policy.owner}`,
      saved ? `Soubor: ${saved.name}` : null,
      'Stav: Návrh — čeká na dopracování a schválení.',
      by(req),
    ]);
    await audit.record(req, { entity: 'policy', entityId: policy.id, action: 'create', after: policy, label: policy.name });
    res.status(201).json(policy);
  });

  app.put('/api/policies/:id', canWrite, uploadDocument, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Dokument nenalezen');
    const p = { ...existing, ...pick(req.body, ['name', 'category', 'version', 'owner', 'status']) };
    const file = pickedFile(req);
    const saved = file ? saveFile(file) : null;
    if (saved) deleteFile(existing.file_stored);
    await db.prepare(`UPDATE policies SET name = ?, category = ?, version = ?, owner = ?, status = ?, updated_at = ?
      ${saved ? ', file_name = ?, file_stored = ?, file_size = ?, file_mime = ?' : ''} WHERE id = ?`)
      .run(...[p.name, p.category, p.version, p.owner, p.status, new Date().toISOString().slice(0, 10),
        ...(saved ? [saved.name, saved.stored, saved.size, saved.mime] : []), req.params.id]);
    if (p.status !== existing.status) {
      await notifier.notify('policy.status', `Dokument „${p.name}": ${p.status}`, [
        `Stav: ${existing.status} → ${p.status}`,
        `Verze: ${p.version}, vlastník: ${p.owner}`,
        saved ? `Nahrán nový soubor: ${saved.name}` : null,
        by(req),
      ]);
    }
    const updated = await db.prepare(`SELECT ${POLICY_COLUMNS} FROM policies WHERE id = ?`).get(req.params.id);
    await audit.record(req, { entity: 'policy', entityId: updated.id, action: 'update', before: existing, after: updated, label: updated.name });
    res.json(updated);
  });

  app.delete('/api/policies/:id', canDelete, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Dokument nenalezen');
    await db.prepare('DELETE FROM policies WHERE id = ?').run(req.params.id);
    deleteFile(existing.file_stored);
    await notifier.notify('policy.deleted', `Dokument smazán: ${existing.name}`, [by(req)]);
    await audit.record(req, { entity: 'policy', entityId: existing.id, action: 'delete', before: existing, label: existing.name });
    res.status(204).end();
  });

  // Stažení přiloženého souboru dokumentu
  app.get('/api/policies/:id/file', async (req, res) => {
    const existing = await db.prepare('SELECT file_name, file_stored, file_mime FROM policies WHERE id = ?').get(req.params.id);
    if (!existing?.file_stored) throw httpError(404, 'Soubor nenalezen');
    // root: absolutní cesta se zpětnými lomítky (Windows) se předaná přímo
    // do res.download() rozbije na encodeURI/send; s 'root' se řeší jen
    // holý (bezpečně vygenerovaný) název souboru bez oddělovačů.
    res.download(existing.file_stored, existing.file_name, { root: UPLOAD_DIR });
  });

  // ---------- Auditní zjištění ----------

  app.get('/api/findings', async (req, res) => {
    res.json(await db.prepare('SELECT * FROM audit_findings ORDER BY id DESC').all());
  });

  // Předdefinovaný číselník vlastníků (LOV) pro formulář
  app.get('/api/findings/owners', (req, res) => {
    res.json(OWNERS);
  });

  app.post('/api/findings', canWrite, async (req, res) => {
    need(req.body, 'finding', 'type', 'due', 'owner');
    const id = await nextId(db, 'audit_findings', 'F');
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO audit_findings (id, finding, type, status, due, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.body.finding.trim(), req.body.type, 'Nové', req.body.due, req.body.owner.trim(), now, now);
    const finding = await db.prepare('SELECT * FROM audit_findings WHERE id = ?').get(id);
    await notifier.notify('finding.created', `Nové zjištění ${id} (${finding.type})`, [
      finding.finding,
      `Termín nápravy: ${finding.due}`,
      `Odpovědná osoba: ${finding.owner}`,
      by(req),
    ]);
    await audit.record(req, { entity: 'finding', entityId: finding.id, action: 'create', after: finding, label: finding.finding });
    res.status(201).json(finding);
  });

  app.put('/api/findings/:id', canWrite, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM audit_findings WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Zjištění nenalezeno');
    const f = { ...existing, ...pick(req.body, ['finding', 'type', 'status', 'due', 'owner']) };
    await db.prepare('UPDATE audit_findings SET finding = ?, type = ?, status = ?, due = ?, owner = ?, updated_at = ? WHERE id = ?')
      .run(f.finding, f.type, f.status, f.due, f.owner, new Date().toISOString(), req.params.id);
    if (f.status !== existing.status) {
      await notifier.notify('finding.status', `Zjištění ${f.id}: ${f.status}`, [
        f.finding,
        `Stav: ${existing.status} → ${f.status}`,
        `Termín: ${f.due}, odpovědná osoba: ${f.owner}`,
        by(req),
      ]);
    }
    const updated = await db.prepare('SELECT * FROM audit_findings WHERE id = ?').get(req.params.id);
    await audit.record(req, { entity: 'finding', entityId: updated.id, action: 'update', before: existing, after: updated, label: updated.finding });
    res.json(updated);
  });

  app.delete('/api/findings/:id', canDelete, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM audit_findings WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Zjištění nenalezeno');
    await db.prepare('DELETE FROM audit_findings WHERE id = ?').run(req.params.id);
    await notifier.notify('finding.deleted', `Zjištění ${existing.id} smazáno`, [existing.finding, by(req)]);
    await audit.record(req, { entity: 'finding', entityId: existing.id, action: 'delete', before: existing, label: existing.finding });
    res.status(204).end();
  });

  // ---------- Řízení změn (ITIL, viz opatření A.8.32) ----------

  app.get('/api/changes', async (req, res) => {
    res.json(await db.prepare('SELECT * FROM changes ORDER BY id DESC').all());
  });

  // Předdefinovaný číselník vlastníků (LOV) pro formulář
  app.get('/api/changes/owners', (req, res) => {
    res.json(OWNERS);
  });

  app.post('/api/changes', canWrite, async (req, res) => {
    need(req.body, 'title', 'type', 'risk_level', 'owner');
    const controlId = await assertRef(db, 'controls', req.body.control_id, 'opatření');
    const riskId = await assertRef(db, 'risks', req.body.risk_id, 'riziko');
    const id = await nextId(db, 'changes', 'CHG');
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO changes (id, title, description, type, risk_level, owner, planned_date, control_id, risk_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.body.title.trim(), (req.body.description ?? '').trim() || null, req.body.type, req.body.risk_level,
        req.body.owner.trim(), req.body.planned_date || null, controlId, riskId, now, now);
    const change = await db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
    await notifier.notify('change.created', `Nová změna ${id}: ${change.title}`, [
      `Typ: ${change.type}, riziko změny: ${change.risk_level}`,
      `Vlastník: ${change.owner}`,
      change.planned_date ? `Plánovaný termín: ${change.planned_date}` : null,
      by(req),
    ]);
    await audit.record(req, { entity: 'change', entityId: change.id, action: 'create', after: change, label: change.title });
    res.status(201).json(change);
  });

  app.put('/api/changes/:id', canWrite, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM changes WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Změna nenalezena');
    const c = {
      ...existing,
      ...pick(req.body, ['title', 'description', 'type', 'risk_level', 'status', 'owner', 'planned_date', 'implemented_date', 'control_id', 'risk_id']),
    };
    if ('control_id' in req.body) c.control_id = await assertRef(db, 'controls', req.body.control_id, 'opatření');
    if ('risk_id' in req.body) c.risk_id = await assertRef(db, 'risks', req.body.risk_id, 'riziko');
    await db.prepare(`UPDATE changes SET title = ?, description = ?, type = ?, risk_level = ?, status = ?, owner = ?,
      planned_date = ?, implemented_date = ?, control_id = ?, risk_id = ?, updated_at = ? WHERE id = ?`)
      .run(c.title, c.description, c.type, c.risk_level, c.status, c.owner, c.planned_date, c.implemented_date, c.control_id, c.risk_id, new Date().toISOString(), req.params.id);
    if (c.status !== existing.status) {
      await notifier.notify('change.status', `Změna ${c.id}: ${c.status}`, [
        `Stav: ${existing.status} → ${c.status}`,
        `Vlastník: ${c.owner}`,
        by(req),
      ]);
    }
    const updated = await db.prepare('SELECT * FROM changes WHERE id = ?').get(req.params.id);
    await audit.record(req, { entity: 'change', entityId: updated.id, action: 'update', before: existing, after: updated, label: updated.title });
    res.json(updated);
  });

  app.delete('/api/changes/:id', canDelete, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM changes WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Změna nenalezena');
    await db.prepare('DELETE FROM changes WHERE id = ?').run(req.params.id);
    await notifier.notify('change.deleted', `Změna ${existing.id} smazána: ${existing.title}`, [by(req)]);
    await audit.record(req, { entity: 'change', entityId: existing.id, action: 'delete', before: existing, label: existing.title });
    res.status(204).end();
  });

  // ---------- Řízení incidentů bezpečnosti informací (ITIL, viz opatření A.5.24–A.5.30) ----------
  //
  // Stav (status) se od workflow akcí níže (assign/start/pause/resume/escalate/
  // resolve/close/reopen) mění výhradně přes ně, ne přes obecný PUT — každá akce
  // validuje, ze kterých stavů je přechod platný (409 jinak), zapisuje řádek do
  // incident_activity (časová osa v ticketDetail) a posílá stejnou e-mailovou
  // notifikaci/audit log jako dřív generický PUT. `owner` (LOV, reporting pohled)
  // a `assigned_to_user_id` (konkrétní řešitel, workflow pohled) jsou nezávislá pole.

  const INCIDENT_TRANSITIONS = {
    start:    { from: ['Přiřazeno'], to: 'V řešení' },
    pause:    { from: ['V řešení'], to: 'Pozastaveno' },
    resume:   { from: ['Pozastaveno'], to: 'V řešení' },
    escalate: { from: ['V řešení', 'Pozastaveno'], to: 'Eskalováno' },
    resolve:  { from: ['V řešení', 'Eskalováno'], to: 'Vyřešeno' },
    close:    { from: ['Vyřešeno'], to: 'Uzavřeno' },
    reopen:   { from: ['Vyřešeno', 'Uzavřeno'], to: 'V řešení' },
  };

  const loadIncident = async (id) => {
    const incident = await db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
    if (!incident) throw httpError(404, 'Incident nenalezen');
    return incident;
  };

  const logIncidentActivity = (req, incidentId, { type, fromStatus = null, toStatus = null, note = null }) =>
    db.prepare(`INSERT INTO incident_activity (incident_id, type, user_id, user_name, from_status, to_status, note, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(incidentId, type, req.user.id, req.user.name, fromStatus, toStatus, note, new Date().toISOString());

  // Validovaný přechod stavu (klíč z INCIDENT_TRANSITIONS) + zápis activity/audit/notifikace.
  const applyIncidentTransition = async (req, res, key, { extra = {}, note = null } = {}) => {
    const def = INCIDENT_TRANSITIONS[key];
    const existing = await loadIncident(req.params.id);
    if (!def.from.includes(existing.status)) {
      throw httpError(409, `Nelze provést akci z aktuálního stavu („${existing.status}")`);
    }
    const fields = { status: def.to, ...extra };
    const setClause = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    await db.prepare(`UPDATE incidents SET ${setClause}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(fields), new Date().toISOString(), req.params.id);
    await logIncidentActivity(req, existing.id, { type: 'status_change', fromStatus: existing.status, toStatus: def.to, note });
    const updated = await loadIncident(existing.id);
    await notifier.notify('incident.status', `Incident ${updated.id}: ${updated.status}`, [
      `Stav: ${existing.status} → ${updated.status}`,
      ...(note ? [`Poznámka: ${note}`] : []),
      `Vlastník: ${updated.owner}`,
      by(req),
    ]);
    await audit.record(req, { entity: 'incident', entityId: updated.id, action: 'update', before: existing, after: updated, label: updated.title });
    res.json(updated);
  };

  app.get('/api/incidents', async (req, res) => {
    res.json(await db.prepare('SELECT * FROM incidents ORDER BY id DESC').all());
  });

  // Předdefinovaný číselník vlastníků (LOV) pro formulář — musí být registrováno
  // před GET /api/incidents/:id, jinak by ho ten (jako '/incidents/owners') odchytil.
  app.get('/api/incidents/owners', (req, res) => {
    res.json(OWNERS);
  });

  app.get('/api/incidents/:id', async (req, res) => {
    res.json(await loadIncident(req.params.id));
  });

  app.get('/api/incidents/:id/activity', async (req, res) => {
    await loadIncident(req.params.id);
    res.json(await db.prepare('SELECT * FROM incident_activity WHERE incident_id = ? ORDER BY at, id').all(req.params.id));
  });

  app.post('/api/incidents', canWrite, async (req, res) => {
    need(req.body, 'title', 'category', 'priority', 'reported_by', 'owner', 'occurred_at');
    const controlId = await assertRef(db, 'controls', req.body.control_id, 'opatření');
    const riskId = await assertRef(db, 'risks', req.body.risk_id, 'riziko');
    const id = await nextId(db, 'incidents', 'INC');
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO incidents (id, title, description, category, priority, reported_by, owner, occurred_at, control_id, risk_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.body.title.trim(), (req.body.description ?? '').trim() || null, req.body.category, req.body.priority,
        req.body.reported_by.trim(), req.body.owner.trim(), req.body.occurred_at, controlId, riskId, now, now);
    const incident = await db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
    await notifier.notify('incident.created', `Nový incident ${id} (${incident.priority}): ${incident.title}`, [
      `Kategorie: ${incident.category}`,
      `Nahlásil: ${incident.reported_by}, vlastník: ${incident.owner}`,
      `Datum vzniku: ${incident.occurred_at}`,
      by(req),
    ]);
    await audit.record(req, { entity: 'incident', entityId: incident.id, action: 'create', after: incident, label: incident.title });
    res.status(201).json(incident);
  });

  app.put('/api/incidents/:id', canWrite, async (req, res) => {
    const existing = await loadIncident(req.params.id);
    const i = {
      ...existing,
      ...pick(req.body, ['title', 'description', 'category', 'priority', 'reported_by', 'owner', 'occurred_at', 'control_id', 'risk_id']),
    };
    if ('control_id' in req.body) i.control_id = await assertRef(db, 'controls', req.body.control_id, 'opatření');
    if ('risk_id' in req.body) i.risk_id = await assertRef(db, 'risks', req.body.risk_id, 'riziko');
    await db.prepare(`UPDATE incidents SET title = ?, description = ?, category = ?, priority = ?, reported_by = ?,
      owner = ?, occurred_at = ?, control_id = ?, risk_id = ?, updated_at = ? WHERE id = ?`)
      .run(i.title, i.description, i.category, i.priority, i.reported_by, i.owner, i.occurred_at, i.control_id, i.risk_id, new Date().toISOString(), req.params.id);
    const updated = await loadIncident(req.params.id);
    await audit.record(req, { entity: 'incident', entityId: updated.id, action: 'update', before: existing, after: updated, label: updated.title });
    res.json(updated);
  });

  app.delete('/api/incidents/:id', canDelete, async (req, res) => {
    const existing = await loadIncident(req.params.id);
    await db.prepare('DELETE FROM incidents WHERE id = ?').run(req.params.id);
    await notifier.notify('incident.deleted', `Incident ${existing.id} smazán: ${existing.title}`, [by(req)]);
    await audit.record(req, { entity: 'incident', entityId: existing.id, action: 'delete', before: existing, label: existing.title });
    res.status(204).end();
  });

  // ---------- Workflow incidentu: přiřazení řešiteli + přechody stavu ----------

  app.post('/api/incidents/:id/comments', canWrite, async (req, res) => {
    need(req.body, 'text');
    const incident = await loadIncident(req.params.id);
    await logIncidentActivity(req, incident.id, { type: 'comment', note: String(req.body.text).trim() });
    res.status(201).json(
      await db.prepare('SELECT * FROM incident_activity WHERE incident_id = ? ORDER BY at DESC, id DESC LIMIT 1').get(incident.id),
    );
  });

  app.post('/api/incidents/:id/assign', canWrite, async (req, res) => {
    need(req.body, 'user_id');
    const existing = await loadIncident(req.params.id);
    if (['Vyřešeno', 'Uzavřeno'].includes(existing.status)) {
      throw httpError(409, `Nelze přiřadit řešitele ve stavu „${existing.status}"`);
    }
    const assignee = await db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.body.user_id);
    if (!assignee) throw httpError(400, 'Neplatný nebo neaktivní uživatel');
    const nextStatus = existing.status === 'Nové' ? 'Přiřazeno' : existing.status;
    await db.prepare('UPDATE incidents SET assigned_to_user_id = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(assignee.id, nextStatus, new Date().toISOString(), existing.id);
    const statusChanged = existing.status !== nextStatus;
    await logIncidentActivity(req, existing.id, {
      type: 'assignment',
      fromStatus: statusChanged ? existing.status : null,
      toStatus: statusChanged ? nextStatus : null,
      note: `Přiřazeno: ${assignee.name}`,
    });
    const updated = await loadIncident(existing.id);
    await notifier.notify('incident.assigned', `Incident ${updated.id}: přiřazen řešitel`, [
      `Řešitel: ${assignee.name}`,
      ...(statusChanged ? [`Stav: ${existing.status} → ${nextStatus}`] : []),
      by(req),
    ]);
    await audit.record(req, { entity: 'incident', entityId: updated.id, action: 'update', before: existing, after: updated, label: updated.title });
    res.json(updated);
  });

  app.post('/api/incidents/:id/start', canWrite, async (req, res) => {
    await applyIncidentTransition(req, res, 'start');
  });

  app.post('/api/incidents/:id/pause', canWrite, async (req, res) => {
    need(req.body, 'reason');
    await applyIncidentTransition(req, res, 'pause', { note: String(req.body.reason).trim() });
  });

  app.post('/api/incidents/:id/resume', canWrite, async (req, res) => {
    await applyIncidentTransition(req, res, 'resume');
  });

  app.post('/api/incidents/:id/escalate', canWrite, async (req, res) => {
    const note = req.body?.note ? String(req.body.note).trim() : null;
    await applyIncidentTransition(req, res, 'escalate', { note });
  });

  app.post('/api/incidents/:id/resolve', canWrite, async (req, res) => {
    need(req.body, 'resolution');
    const resolution = String(req.body.resolution).trim();
    await applyIncidentTransition(req, res, 'resolve', {
      extra: { resolution, resolved_at: new Date().toISOString().slice(0, 10) },
      note: resolution,
    });
  });

  app.post('/api/incidents/:id/close', canWrite, async (req, res) => {
    await applyIncidentTransition(req, res, 'close');
  });

  app.post('/api/incidents/:id/reopen', canWrite, async (req, res) => {
    need(req.body, 'reason');
    const reason = String(req.body.reason).trim();
    await applyIncidentTransition(req, res, 'reopen', { extra: { resolved_at: null, resolution: null }, note: reason });
  });

  // ---------- Školení a FAQ ----------

  const canManageTrainings = requireRole('manager');

  // Cílová skupina školení je LOV rolí (ne volný text) — určuje, komu se
  // školení vůbec zobrazí (viz GET /api/trainings) a vůči komu se počítá pct.
  const ALL_ROLES = ['reader', 'editor', 'manager'];
  const ROLE_LABELS = { reader: 'Čtenáři', editor: 'Editoři', manager: 'Manažeři' };
  const audienceLabel = (roles) => (roles.length === ALL_ROLES.length ? 'Všichni uživatelé' : roles.map((r) => ROLE_LABELS[r]).join(', '));

  const validateTargetRoles = (roles) => {
    if (!Array.isArray(roles) || roles.length === 0) throw httpError(400, 'Vyberte alespoň jednu cílovou roli');
    for (const r of roles) if (!ALL_ROLES.includes(r)) throw httpError(400, `Neplatná role: ${r}`);
    return [...new Set(roles)];
  };

  // Ověří a normalizuje otázky kvízu z požadavku administrace školení
  const validateQuestions = (questions) => {
    if (!Array.isArray(questions) || questions.length === 0) {
      throw httpError(400, 'Kvíz musí mít alespoň jednu otázku');
    }
    return questions.map((q) => {
      if (!q?.q || typeof q.q !== 'string' || !q.q.trim()) throw httpError(400, 'Otázka nesmí být prázdná');
      if (!Array.isArray(q.options) || q.options.length < 2) throw httpError(400, `Otázka „${q.q}" musí mít alespoň dvě možnosti`);
      if (q.options.some((o) => typeof o !== 'string' || !o.trim())) throw httpError(400, `Otázka „${q.q}" má prázdnou možnost odpovědi`);
      if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) {
        throw httpError(400, `Otázka „${q.q}" má neplatný index správné odpovědi`);
      }
      return { q: q.q.trim(), options: q.options.map((o) => o.trim()), correct: q.correct };
    });
  };

  // U školení s kvízem (content) se pct počítá živě z absolvování mezi uživateli
  // portálu, kteří spadají do cílové skupiny (target_roles) — ne mezi úplně
  // všemi. U starších/statických záznamů (content NULL) se vrací uložená
  // hodnota z návrhu. 'content' (se správnými odpověďmi) se sem záměrně
  // nedává — bez ohledu na to, viz GET .../quiz.
  const trainingView = async (t, userId) => {
    const hasQuiz = Boolean(t.content);
    const targetRoles = JSON.parse(t.target_roles);
    const placeholders = targetRoles.map(() => '?').join(',');
    const targetUserCount = (await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role IN (${placeholders})`).get(...targetRoles)).n;
    const passedCount = hasQuiz
      ? (await db.prepare(`SELECT COUNT(*) AS n FROM training_completions tc JOIN users u ON u.id = tc.user_id
          WHERE tc.training_id = ? AND tc.passed = 1 AND u.role IN (${placeholders})`).get(t.id, ...targetRoles)).n
      : null;
    const mine = hasQuiz
      ? await db.prepare('SELECT score, passed, completed_at FROM training_completions WHERE training_id = ? AND user_id = ?').get(t.id, userId)
      : null;
    return {
      id: t.id,
      name: t.name,
      audience: audienceLabel(targetRoles),
      targetRoles,
      due: t.due,
      hasQuiz,
      pct: hasQuiz ? (targetUserCount > 0 ? Math.round((passedCount / targetUserCount) * 100) : 0) : t.pct,
      myCompletion: mine ? { score: mine.score, passed: Boolean(mine.passed), completedAt: mine.completed_at } : null,
    };
  };

  // Čtenáři/editoři vidí jen školení určená jejich roli; manažer vidí a
  // spravuje úplně všechna (potřebuje je moci upravit/smazat bez ohledu na to,
  // komu jsou určená).
  app.get('/api/trainings', async (req, res) => {
    const rows = await db.prepare('SELECT id, name, due, pct, content, target_roles FROM trainings ORDER BY id').all();
    const visible = req.user.role === 'manager'
      ? rows
      : rows.filter((t) => JSON.parse(t.target_roles).includes(req.user.role));
    res.json(await Promise.all(visible.map((t) => trainingView(t, req.user.id))));
  });

  // ---------- Administrace školení (jen manažer) ----------

  // Na rozdíl od GET .../quiz (pro absolvování, bez 'correct') vrací plný
  // obsah kvízu vč. správných odpovědí — pro předvyplnění formuláře úpravy.
  app.get('/api/trainings/:id', canManageTrainings, async (req, res) => {
    const training = await db.prepare('SELECT id, name, due, content, target_roles FROM trainings WHERE id = ?').get(req.params.id);
    if (!training) throw httpError(404, 'Školení nenalezeno');
    res.json({
      id: training.id,
      name: training.name,
      due: training.due,
      targetRoles: JSON.parse(training.target_roles),
      questions: training.content ? JSON.parse(training.content) : [],
    });
  });

  app.post('/api/trainings', canManageTrainings, async (req, res) => {
    need(req.body, 'name', 'due');
    const targetRoles = validateTargetRoles(req.body.target_roles);
    const questions = validateQuestions(req.body.questions);
    const training = await db.prepare(`INSERT INTO trainings (name, audience, due, pct, content, target_roles) VALUES (?, ?, ?, 0, ?, ?)
      RETURNING id, name, due, pct, content, target_roles`)
      .get(req.body.name.trim(), audienceLabel(targetRoles), req.body.due, JSON.stringify(questions), JSON.stringify(targetRoles));
    await notifier.notify('training.created', `Nové školení: ${training.name}`, [
      `Cílová skupina: ${audienceLabel(targetRoles)}`,
      `Termín: ${training.due}`,
      `Počet otázek: ${questions.length}`,
      by(req),
    ]);
    await audit.record(req, {
      entity: 'training', entityId: training.id, action: 'create',
      after: { name: training.name, audience: audienceLabel(targetRoles), due: training.due }, label: training.name,
    });
    res.status(201).json(await trainingView(training, req.user.id));
  });

  app.put('/api/trainings/:id', canManageTrainings, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM trainings WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Školení nenalezeno');
    const t = { ...existing, ...pick(req.body, ['name', 'due']) };
    const targetRoles = req.body.target_roles ? validateTargetRoles(req.body.target_roles) : JSON.parse(existing.target_roles);
    const content = req.body.questions ? JSON.stringify(validateQuestions(req.body.questions)) : existing.content;
    await db.prepare('UPDATE trainings SET name = ?, audience = ?, due = ?, content = ?, target_roles = ? WHERE id = ?')
      .run(t.name, audienceLabel(targetRoles), t.due, content, JSON.stringify(targetRoles), req.params.id);
    const updated = await db.prepare('SELECT id, name, due, pct, content, target_roles FROM trainings WHERE id = ?').get(req.params.id);
    await audit.record(req, {
      entity: 'training', entityId: updated.id, action: 'update',
      before: { name: existing.name, audience: existing.audience, due: existing.due },
      after: { name: updated.name, audience: audienceLabel(targetRoles), due: updated.due },
      label: updated.name,
    });
    res.json(await trainingView(updated, req.user.id));
  });

  app.delete('/api/trainings/:id', canManageTrainings, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM trainings WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Školení nenalezeno');
    await db.prepare('DELETE FROM trainings WHERE id = ?').run(req.params.id); // smaže i training_completions (ON DELETE CASCADE)
    await notifier.notify('training.deleted', `Školení smazáno: ${existing.name}`, [by(req)]);
    await audit.record(req, { entity: 'training', entityId: existing.id, action: 'delete', before: { name: existing.name }, label: existing.name });
    res.status(204).end();
  });

  // Přehled absolvování za uživatele v cílové skupině školení (roster)
  app.get('/api/trainings/:id/completions', canManageTrainings, async (req, res) => {
    const training = await db.prepare('SELECT id, name, target_roles FROM trainings WHERE id = ?').get(req.params.id);
    if (!training) throw httpError(404, 'Školení nenalezeno');
    const targetRoles = JSON.parse(training.target_roles);
    const placeholders = targetRoles.map(() => '?').join(',');
    const rows = await db.prepare(`
      SELECT u.id AS user_id, u.name, u.role, tc.score, tc.passed, tc.completed_at
      FROM users u
      LEFT JOIN training_completions tc ON tc.user_id = u.id AND tc.training_id = ?
      WHERE u.role IN (${placeholders})
      ORDER BY u.name
    `).all(training.id, ...targetRoles);
    res.json(rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      role: r.role,
      score: r.score ?? null,
      passed: r.passed == null ? null : Boolean(r.passed),
      completedAt: r.completed_at ?? null,
    })));
  });

  // Otázky kvízu bez správných odpovědí (ty se ověřují až na POST .../complete)
  app.get('/api/trainings/:id/quiz', async (req, res) => {
    const training = await db.prepare('SELECT id, name, content, target_roles FROM trainings WHERE id = ?').get(req.params.id);
    if (!training?.content) throw httpError(404, 'Školení nemá interaktivní obsah');
    if (req.user.role !== 'manager' && !JSON.parse(training.target_roles).includes(req.user.role)) {
      throw httpError(403, 'Toto školení není určeno pro vaši roli');
    }
    const questions = JSON.parse(training.content).map(({ q, options }) => ({ q, options }));
    res.json({ id: training.id, name: training.name, questions, threshold: TRAINING_PASS_THRESHOLD });
  });

  app.post('/api/trainings/:id/complete', async (req, res) => {
    const training = await db.prepare('SELECT id, content, target_roles FROM trainings WHERE id = ?').get(req.params.id);
    if (!training?.content) throw httpError(404, 'Školení nemá interaktivní obsah');
    if (req.user.role !== 'manager' && !JSON.parse(training.target_roles).includes(req.user.role)) {
      throw httpError(403, 'Toto školení není určeno pro vaši roli');
    }
    const questions = JSON.parse(training.content);
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (answers.length !== questions.length) throw httpError(400, `Očekáváno ${questions.length} odpovědí`);

    const correctCount = questions.reduce((n, q, i) => n + (answers[i] === q.correct ? 1 : 0), 0);
    const score = Math.round((correctCount / questions.length) * 100);
    const passed = score >= TRAINING_PASS_THRESHOLD ? 1 : 0;
    await db.prepare(`INSERT INTO training_completions (training_id, user_id, score, passed, completed_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (training_id, user_id) DO UPDATE SET score = excluded.score, passed = excluded.passed, completed_at = excluded.completed_at`)
      .run(training.id, req.user.id, score, passed, new Date().toISOString());

    res.json({ score, passed: Boolean(passed), correctCount, total: questions.length, threshold: TRAINING_PASS_THRESHOLD });
  });

  app.get('/api/faqs', async (req, res) => {
    res.json(await db.prepare('SELECT * FROM faqs ORDER BY position').all());
  });

  // ---------- Notifikace (outbox, jen manažer) ----------

  app.get('/api/notifications', requireRole('manager'), async (req, res) => {
    res.json(await db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 50').all());
  });

  // ---------- Správa uživatelů (jen manažer) ----------

  const USER_ROLES = ['reader', 'editor', 'manager'];
  const USER_COLUMNS = 'id, username, name, title, email, role, active, created_at';
  const canManageUsers = requireRole('manager');

  const validateUserRole = (role) => {
    if (!USER_ROLES.includes(role)) throw httpError(400, `Neplatná role: ${role}`);
    return role;
  };

  // Kolik dalších (jiných než excludeId) aktivních manažerů v systému zůstává —
  // používá se jako pojistka proti odebrání posledního manažera.
  const otherActiveManagers = async (excludeId) =>
    (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'manager' AND active = 1 AND id != ?").get(excludeId)).n;

  app.get('/api/users', canManageUsers, async (req, res) => {
    res.json(await db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY name`).all());
  });

  // Minimální seznam aktivních uživatelů pro výběr řešitele incidentu — na
  // rozdíl od GET /api/users (jen manažer) je dostupný komukoli přihlášenému,
  // aby si i editor mohl v ticketDetail přiřadit řešitele.
  app.get('/api/users/assignable', async (req, res) => {
    res.json(await db.prepare("SELECT id, name FROM users WHERE active = 1 ORDER BY name").all());
  });

  app.post('/api/users', canManageUsers, async (req, res) => {
    need(req.body, 'username', 'name', 'role', 'password');
    const role = validateUserRole(req.body.role);
    const username = String(req.body.username).trim().toLowerCase();
    if (!username) throw httpError(400, 'Uživatelské jméno nesmí být prázdné');
    if (await db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw httpError(400, 'Uživatelské jméno již existuje');
    }
    if (String(req.body.password).length < 8) throw httpError(400, 'Heslo musí mít alespoň 8 znaků');

    const user = await db.prepare(`INSERT INTO users (username, name, title, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING ${USER_COLUMNS}`)
      .get(username, req.body.name.trim(), (req.body.title ?? '').trim() || null,
        (req.body.email ?? '').trim() || null, role, hashPassword(String(req.body.password)), new Date().toISOString());
    await notifier.notify('user.created', `Nový uživatelský účet: ${user.name} (${user.username})`, [
      `Role: ${user.role}`,
      by(req),
    ]);
    await audit.record(req, {
      entity: 'user', entityId: user.id, action: 'create',
      after: { username: user.username, name: user.name, role: user.role }, label: user.name,
    });
    res.status(201).json(user);
  });

  app.put('/api/users/:id', canManageUsers, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Uživatel nenalezen');

    if (String(req.user.id) === String(existing.id) && req.body.active === false) {
      throw httpError(400, 'Nemůžete deaktivovat svůj vlastní účet');
    }

    const role = req.body.role !== undefined ? validateUserRole(req.body.role) : existing.role;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : existing.active;
    const losesManager = existing.role === 'manager' && existing.active === 1 && (role !== 'manager' || active === 0);
    if (losesManager && (await otherActiveManagers(existing.id)) === 0) {
      throw httpError(400, 'Nelze odebrat roli/deaktivovat posledního aktivního manažera');
    }

    let username = existing.username;
    if (req.body.username !== undefined) {
      username = String(req.body.username).trim().toLowerCase();
      if (!username) throw httpError(400, 'Uživatelské jméno nesmí být prázdné');
      if (await db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, existing.id)) {
        throw httpError(400, 'Uživatelské jméno již existuje');
      }
    }

    const name = req.body.name !== undefined ? req.body.name.trim() : existing.name;
    const title = req.body.title !== undefined ? ((req.body.title ?? '').trim() || null) : existing.title;
    const email = req.body.email !== undefined ? ((req.body.email ?? '').trim() || null) : existing.email;

    let passwordHash = existing.password_hash;
    if (req.body.password) {
      if (String(req.body.password).length < 8) throw httpError(400, 'Heslo musí mít alespoň 8 znaků');
      passwordHash = hashPassword(String(req.body.password));
    }

    await db.prepare('UPDATE users SET username = ?, name = ?, title = ?, email = ?, role = ?, active = ?, password_hash = ? WHERE id = ?')
      .run(username, name, title, email, role, active, passwordHash, existing.id);
    if (active === 0) await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id); // okamžité odhlášení

    const updated = await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(existing.id);
    await audit.record(req, {
      entity: 'user', entityId: updated.id, action: 'update',
      before: { username: existing.username, name: existing.name, role: existing.role, active: existing.active },
      after: { username: updated.username, name: updated.name, role: updated.role, active: updated.active },
      label: updated.name,
    });
    if (Boolean(existing.active) !== Boolean(updated.active)) {
      await notifier.notify('user.status', `Uživatelský účet ${updated.active ? 'aktivován' : 'deaktivován'}: ${updated.name}`, [
        `Uživatelské jméno: ${updated.username}`,
        by(req),
      ]);
    }
    res.json(updated);
  });

  // ---------- Auditní stopa (jen manažer) ----------

  app.get('/api/audit-log', requireRole('manager'), async (req, res) => {
    const { entity, entityId } = req.query;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const where = [];
    const params = [];
    if (entity) { where.push('entity = ?'); params.push(entity); }
    if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
    const sql = `SELECT * FROM audit_log${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    const rows = await db.prepare(sql).all(...params, limit);
    res.json(rows.map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : null })));
  });

  // ---------- Dashboard (vše počítáno živě z DB) ----------

  app.get('/api/dashboard', async (req, res) => {
    const controls = await db.prepare('SELECT * FROM controls').all();
    const { domains, overallPct } = domainCompliance(controls);

    const openRisks = (await db.prepare("SELECT COUNT(*) AS n FROM risks WHERE status = 'Otevřené'").get()).n;
    const highRisks = (await db.prepare("SELECT COUNT(*) AS n FROM risks WHERE status = 'Otevřené' AND level = 'Vysoké'").get()).n;

    const today = new Date().toISOString().slice(0, 10);
    const overdueFindings = (await db.prepare(
      "SELECT COUNT(*) AS n FROM audit_findings WHERE status != 'Uzavřeno' AND (status = 'Po termínu' OR due < ?)",
    ).get(today)).n;

    const in30days = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const reviewSoon = await db.prepare(
      'SELECT domain, COUNT(*) AS n FROM controls WHERE review_due IS NOT NULL AND review_due <= ? GROUP BY domain',
    ).all(in30days);

    const alerts = [];
    for (const r of reviewSoon) {
      alerts.push({
        severity: 'warn',
        text: `${r.n} opatření přílohy A vyžadují přezkoumání do 30 dnů – doména ${r.domain} bezpečnost.`,
      });
    }
    if (overdueFindings > 0) {
      alerts.push({
        severity: 'danger',
        text: `${overdueFindings} nápravná opatření z interního auditu jsou po termínu plnění – vyžadují eskalaci vedení.`,
      });
    }

    const setting = async (key) => (await db.prepare('SELECT value FROM settings WHERE key = ?').get(key))?.value ?? null;

    res.json({
      compliance: {
        overallPct,
        targetPct: Number((await setting('compliance_target_pct')) ?? 90),
        byDomain: domains,
      },
      risks: { open: openRisks, high: highRisks },
      findings: { overdue: overdueFindings },
      nextAudit: { date: await setting('next_audit_date'), auditor: await setting('next_audit_auditor') },
      deadlines: await db.prepare('SELECT * FROM deadlines ORDER BY due').all(),
      alerts,
    });
  });
}

// Z objektu vybere jen povolená pole (ignoruje undefined)
function pick(body, fields) {
  const out = {};
  for (const f of fields) {
    if (body?.[f] !== undefined) out[f] = body[f];
  }
  return out;
}
