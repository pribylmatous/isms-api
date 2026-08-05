// Převod stávajících dat prototypu (isms-portal-react/src/data.js) do SQLite.
// Spuštění: npm run seed  (idempotentní — tabulky vyprázdní a naplní znovu)

import { openDb, DB_PATH } from './db.js';
import { hashPassword } from './auth.js';
import { CATALOG } from './catalog.js';

// '02.08.2026' → '2026-08-02'
const czToIso = (cz) => {
  const [d, m, y] = cz.split('.');
  return `${y}-${m}-${d}`;
};
const czToIsoOrNull = (cz) => (cz ? czToIso(cz) : null);

const domainOf = (id) =>
  id.startsWith('A.5') ? 'Organizační'
    : id.startsWith('A.6') ? 'Lidské zdroje'
      : id.startsWith('A.7') ? 'Fyzická bezpečnost'
        : 'Technologická';

// review_due: tři technologická opatření mají přezkum do 30 dnů
// (odpovídá upozornění na dashboardu návrhu)
const REVIEW_DUE = { 'A.8.8': '2026-08-20', 'A.8.12': '2026-08-20', 'A.8.24': '2026-08-20' };

// Demo stav zavedení: zvoleno tak, aby shoda domén odpovídala záměru návrhu
// (A.5 ≈ 82 %, A.6 ≈ 90 %, A.7 = 75 %, A.8 ≈ 64 %). Vše ostatní 'Zavedeno'.
const STATUS_PARTIAL = new Set([
  'A.5.7', 'A.5.9', 'A.5.19', 'A.5.21', 'A.5.29', 'A.5.30', 'A.5.35',
  'A.6.7',
  'A.7.4', 'A.7.7', 'A.7.9',
  'A.8.1', 'A.8.5', 'A.8.8', 'A.8.9', 'A.8.15', 'A.8.22', 'A.8.24', 'A.8.25', 'A.8.32',
]);
const STATUS_MISSING = new Set([
  'A.5.13', 'A.5.23', 'A.5.28',
  'A.7.10', 'A.7.14',
  'A.8.4', 'A.8.10', 'A.8.11', 'A.8.12', 'A.8.28', 'A.8.29', 'A.8.30', 'A.8.33',
]);

const DEFAULT_OWNER = {
  'Organizační': 'J. Kovářová',
  'Lidské zdroje': 'HR oddělení',
  'Fyzická bezpečnost': 'Správa budov',
  'Technologická': 'P. Dvořák, IT',
};
const OWNER_OVERRIDES = {
  'A.5.1': 'M. Novák, ředitel', 'A.5.4': 'M. Novák, ředitel',
  'A.5.23': 'P. Dvořák, IT',
  'A.5.31': 'M. Novák, ředitel', 'A.5.32': 'M. Novák, ředitel',
  'A.5.33': 'M. Novák, ředitel', 'A.5.34': 'M. Novák, ředitel',
  'A.7.9': 'P. Dvořák, IT',
  'A.8.12': 'J. Kovářová', 'A.8.24': 'J. Kovářová',
  'A.8.15': 'SOC tým', 'A.8.16': 'SOC tým', 'A.8.17': 'SOC tým',
  'A.8.25': 'Vývojový tým', 'A.8.26': 'Vývojový tým', 'A.8.27': 'Vývojový tým',
  'A.8.28': 'Vývojový tým', 'A.8.29': 'Vývojový tým', 'A.8.30': 'Vývojový tým',
  'A.8.31': 'Vývojový tým', 'A.8.33': 'Vývojový tým',
};

const controlStatus = (id) =>
  STATUS_MISSING.has(id) ? 'Chybí' : STATUS_PARTIAL.has(id) ? 'Částečně zavedeno' : 'Zavedeno';

const CONTROLS = CATALOG.map(([id, name]) => {
  const domain = domainOf(id);
  return [id, name, controlStatus(id), OWNER_OVERRIDES[id] ?? DEFAULT_OWNER[domain]];
});

// probability/impact u historických záznamů neznáme (v návrhu bylo jen skóre) → NULL
const RISKS = [
  ['R-01', 'Únik osobních údajů z výzkumné databáze', 'Databáze výzkumných dat', 6, 'Střední', 'M. Novák', 'Šifrování + řízení přístupu v realizaci'],
  ['R-02', 'Ransomware na serverové infrastruktuře', 'Serverová farma', 12, 'Vysoké', 'P. Dvořák', 'Zálohování offline, EDR nasazeno'],
  ['R-03', 'Neautorizovaný přístup přes VPN', 'Vzdálený přístup', 9, 'Vysoké', 'J. Kovářová', 'MFA zavedeno, revize práv probíhá'],
  ['R-04', 'Výpadek elektrické energie v datovém centru', 'Datové centrum', 4, 'Nízké', 'Správa budov', 'UPS a záložní zdroj instalovány'],
  ['R-05', 'Chybná konfigurace cloudového úložiště', 'Cloudové úložiště (Azure)', 8, 'Vysoké', 'P. Dvořák', 'Automatizovaný audit konfigurace plánován'],
  ['R-06', 'Phishingový útok na zaměstnance', 'E-mailový systém', 6, 'Střední', 'J. Kovářová', 'Simulace phishingu + školení'],
  ['R-07', 'Ztráta mobilního zařízení s daty', 'Notebooky a mobilní zařízení', 4, 'Nízké', 'HR oddělení', 'Šifrování disku, vzdálené smazání'],
  ['R-08', 'Nedostupnost dodavatele klíčové služby', 'Outsourcovaná IT podpora', 6, 'Střední', 'M. Novák', 'Revize SLA a alternativní dodavatel'],
];

const POLICIES = [
  ['Politika bezpečnosti informací', 'Řídicí dokumentace', '3.2', '10.01.2026', 'M. Novák, ředitel', 'Schváleno'],
  ['Politika řízení přístupu', 'Řídicí dokumentace', '2.1', '05.03.2026', 'J. Kovářová', 'Schváleno'],
  ['Postup řízení rizik', 'Postupy', '1.4', '22.02.2026', 'J. Kovářová', 'K revizi'],
  ['Plán kontinuity činností (BCP)', 'Postupy', '2.0', '15.11.2025', 'P. Dvořák', 'K revizi'],
  ['Politika klasifikace informací', 'Řídicí dokumentace', '1.2', '30.04.2026', 'M. Novák, ředitel', 'Schváleno'],
  ['Postup reakce na bezpečnostní incidenty', 'Postupy', '1.0', '18.06.2026', 'SOC tým', 'Návrh'],
];

const FINDINGS = [
  ['F-14', 'Chybějící evidence školení nových zaměstnanců za Q1', 'Neshoda', 'V řešení', '05.08.2026', 'HR oddělení'],
  ['F-13', 'Zastaralá verze politiky klasifikace informací', 'Neshoda', 'Uzavřeno', '01.05.2026', 'M. Novák'],
  ['F-12', 'Nedostatečné logování administrátorských účtů', 'Neshoda', 'Po termínu', '30.06.2026', 'P. Dvořák'],
  ['F-11', 'Doporučení: automatizovat revizi přístupových práv', 'Doporučení', 'Nové', '30.09.2026', 'J. Kovářová'],
  ['F-10', 'Chybějící DPIA u nového výzkumného projektu', 'Neshoda', 'Po termínu', '01.07.2026', 'M. Novák'],
  ['F-09', 'Pozorování: zlepšit značení fyzických nosičů dat', 'Pozorování', 'Uzavřeno', '12.03.2026', 'Správa budov'],
];

// [id, title, description, type, risk_level, status, owner, planned_date, implemented_date, control_id, risk_id]
// Datum a vazby na opatření/rizika jsou nepovinné (NULL) — viz poslední dva sloupce.
const CHANGES = [
  ['CHG-01', 'Nasazení EDR na serverovou infrastrukturu',
    'Instalace a konfigurace nástroje pro detekci a reakci na koncových bodech (EDR) na všech produkčních serverech.',
    'Normální', 'Střední', 'Realizováno', 'SOC tým', '15.06.2026', '20.06.2026', 'A.8.7', 'R-02'],
  ['CHG-02', 'Zavedení MFA pro vzdálený přístup přes VPN',
    'Rozšíření vícefaktorové autentizace na všechny účty s VPN přístupem dle doporučení bezpečnostního auditu.',
    'Normální', 'Vysoké', 'Naplánováno', 'P. Dvořák', '10.08.2026', null, 'A.8.5', 'R-03'],
  ['CHG-03', 'Aktualizace firewallových pravidel pro segmentaci sítě',
    'Zpřesnění pravidel mezi produkčním a vývojovým segmentem sítě.',
    'Standardní', 'Nízké', 'Schváleno', 'P. Dvořák', '25.08.2026', null, 'A.8.22', null],
  ['CHG-04', 'Nouzová záplata kritické zranitelnosti webového serveru',
    'Mimořádná instalace bezpečnostní záplaty po zveřejnění kritické CVE dodavatelem.',
    'Nouzová', 'Vysoké', 'Realizováno', 'Vývojový tým', '02.07.2026', '02.07.2026', 'A.8.8', null],
];

// [id, title, description, category, priority, status, reported_by, owner, occurred_at, resolved_at, resolution, control_id, risk_id]
const INCIDENTS = [
  ['INC-01', 'Phishingový e-mail cílený na finanční oddělení',
    'Zaměstnanec nahlásil podezřelý e-mail vyzývající k zadání přihlašovacích údajů do falešného portálu.',
    'Phishing', 'Vysoká', 'Vyřešeno', 'HR oddělení', 'SOC tým', '12.05.2026', '13.05.2026',
    'E-mail identifikován a nahlášen, odkaz zablokován na proxy, uživatelé preventivně informováni.', 'A.5.26', 'R-06'],
  ['INC-02', 'Neobvyklý přístup k VPN mimo pracovní dobu',
    'Systém zaznamenal přihlášení k VPN v netypickou hodinu z nové geolokace.',
    'Neoprávněný přístup', 'Střední', 'Uzavřeno', 'SOC tým', 'P. Dvořák', '02.06.2026', '03.06.2026',
    'Ověřeno jako legitimní přístup vzdáleného zaměstnance po změně časového pásma; incident uzavřen bez dalších opatření.',
    'A.5.15', 'R-03'],
  ['INC-03', 'Krátkodobý výpadek e-mailového serveru',
    'Poštovní server přestal krátkodobě přijímat a odesílat zprávy.',
    'Dostupnost/výpadek', 'Nízká', 'Uzavřeno', 'SOC tým', 'P. Dvořák', '18.04.2026', '18.04.2026',
    'Restart poštovního serveru, incident trval 25 minut, bez ztráty dat.', 'A.5.30', null],
  ['INC-04', 'Podezření na neautorizovaný přístup do cloudového úložiště',
    'Monitoring zaznamenal neobvyklé API volání vůči cloudovému úložišti mimo definovaná pravidla.',
    'Neoprávněný přístup', 'Kritická', 'Eskalováno', 'SOC tým', 'P. Dvořák', '25.07.2026', null, null,
    'A.8.16', 'R-05'],
];

// Kvíz interaktivního (skutečně absolvovatelného) školení — 'correct' je index
// správné odpovědi; serveru se posílají jen 'q'/'options' (viz GET .../quiz).
const PASSWORD_QUIZ = [
  {
    q: 'Jak by mělo vypadat bezpečné heslo?',
    options: ['Alespoň 6 znaků', 'Alespoň 12 znaků a kombinace typů znaků', 'Jméno mazlíčka a rok narození', 'Stejné heslo jako do e-mailu, ať si ho pamatuji'],
    correct: 1,
  },
  {
    q: 'Obdržíte e-mail s odkazem od neznámého odesílatele, který vás vyzývá k okamžitému přihlášení. Co uděláte?',
    options: ['Kliknu a přihlásím se, ať vidím, o co jde', 'Přepošlu odkaz kolegům, ať to zkontrolují', 'Nahlásím to SOC týmu a odkaz neotevřu', 'Odpovím odesílateli a zeptám se, o co jde'],
    correct: 2,
  },
  {
    q: 'Smíte sdílet své přístupové heslo s kolegou, "jen na chvíli"?',
    options: ['Ano, pokud kolegovi důvěřuji', 'Ano, se souhlasem nadřízeného', 'Ne, hesla se nikdy nesdílejí', 'Ano, pokud si ho pak sám změním'],
    correct: 2,
  },
  {
    q: 'Jak nejlépe uchovávat hesla, abyste je nezapomněli?',
    options: ['Napsat na papírek u monitoru', 'Použít správce hesel (password manager)', 'Uložit do nezašifrovaného textového souboru', 'Používat všude stejné heslo'],
    correct: 1,
  },
];

const TRAININGS = [
  ['Testovací školení: Hesla a phishing', 'Všichni uživatelé', '30.09.2026', 0, JSON.stringify(PASSWORD_QUIZ), JSON.stringify(['reader', 'editor', 'manager'])],
];

const FAQS = [
  ['Jak často se aktualizuje registr rizik?', 'Registr rizik je přezkoumáván čtvrtletně bezpečnostním týmem a mimořádně při zásadní změně infrastruktury nebo po bezpečnostním incidentu.'],
  ['Kdo schvaluje nové nebo revidované politiky?', 'Všechny řídicí dokumenty schvaluje ředitel CDV na návrh manažera kybernetické bezpečnosti po projednání s příslušnými vlastníky procesů.'],
  ['Co dělat při podezření na bezpečnostní incident?', 'Neprodleně kontaktujte SOC tým na interní lince 4444 nebo e-mailem na incident@cdv.cz a postupujte dle Postupu reakce na bezpečnostní incidenty.'],
];

const DEADLINES = [
  ['Přezkoumání politiky řízení přístupu', 'J. Kovářová, IT bezpečnost', '02.08.2026', 'neutral'],
  ['Penetrační test webových aplikací', 'Externí dodavatel', '18.08.2026', 'neutral'],
  ['Roční školení bezpečnosti', 'Všichni zaměstnanci', '31.08.2026', 'warn'],
  ['Recertifikační audit ISO 27001', 'CQS, s.r.o.', '14.09.2026', 'danger'],
];

const SETTINGS = [
  ['next_audit_date', '2026-09-14'],
  ['next_audit_auditor', 'CQS, s.r.o.'],
  ['compliance_target_pct', '90'],
  ['notify_recipients', 'mpribyl@expect-it.cz'],
];

// Vývojové účty — POUZE pro lokální vývoj, v produkci nahradí SSO / změněná hesla.
// Testovací verze: všechny účty mají testovací adresu mpribyl@expect-it.cz
const USERS = [
  ['j.kovarova', 'J. Kovářová', 'Manažer kybernetické bezpečnosti', 'mpribyl@expect-it.cz', 'manager', 'Isms.2026'],
  ['p.dvorak', 'P. Dvořák', 'Správce IT', 'mpribyl@expect-it.cz', 'editor', 'Editor.2026'],
  ['zamestnanec', 'Testovací zaměstnanec', 'Zaměstnanec', 'mpribyl@expect-it.cz', 'reader', 'Cdv.2026'],
];

const db = openDb();

db.exec('BEGIN');
try {
  for (const t of [
    'controls', 'risks', 'policies', 'audit_findings', 'changes', 'incidents',
    'trainings', 'faqs', 'deadlines', 'settings', 'audit_log', 'notifications', 'sessions', 'users',
  ]) {
    db.exec(`DELETE FROM ${t}`);
  }

  const insControl = db.prepare('INSERT INTO controls (id, name, domain, status, owner, review_due) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, name, status, owner] of CONTROLS) {
    insControl.run(id, name, domainOf(id), status, owner, REVIEW_DUE[id] ?? null);
  }

  const insRisk = db.prepare('INSERT INTO risks (id, name, asset, probability, impact, score, level, owner, treatment) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)');
  for (const [id, name, asset, score, level, owner, treatment] of RISKS) {
    insRisk.run(id, name, asset, score, level, owner, treatment);
  }

  const insPolicy = db.prepare('INSERT INTO policies (name, category, version, owner, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [name, category, version, updated, owner, status] of POLICIES) {
    insPolicy.run(name, category, version, owner, status, czToIso(updated));
  }

  const insFinding = db.prepare('INSERT INTO audit_findings (id, finding, type, status, due, owner) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, finding, type, status, due, owner] of FINDINGS) {
    insFinding.run(id, finding, type, status, czToIso(due), owner);
  }

  const insChange = db.prepare(`INSERT INTO changes
    (id, title, description, type, risk_level, status, owner, planned_date, implemented_date, control_id, risk_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [id, title, description, type, riskLevel, status, owner, planned, implemented, controlId, riskId] of CHANGES) {
    insChange.run(id, title, description, type, riskLevel, status, owner, czToIsoOrNull(planned), czToIsoOrNull(implemented), controlId, riskId);
  }

  const insIncident = db.prepare(`INSERT INTO incidents
    (id, title, description, category, priority, status, reported_by, owner, occurred_at, resolved_at, resolution, control_id, risk_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [id, title, description, category, priority, status, reportedBy, owner, occurred, resolved, resolution, controlId, riskId] of INCIDENTS) {
    insIncident.run(id, title, description, category, priority, status, reportedBy, owner, czToIsoOrNull(occurred), czToIsoOrNull(resolved), resolution, controlId, riskId);
  }

  const insTraining = db.prepare('INSERT INTO trainings (name, audience, due, pct, content, target_roles) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [name, audience, due, pct, content, targetRoles] of TRAININGS) {
    insTraining.run(name, audience, czToIso(due), pct, content, targetRoles);
  }

  const insFaq = db.prepare('INSERT INTO faqs (question, answer, position) VALUES (?, ?, ?)');
  FAQS.forEach(([q, a], i) => insFaq.run(q, a, i));

  const insDeadline = db.prepare('INSERT INTO deadlines (title, owner, due, severity) VALUES (?, ?, ?, ?)');
  for (const [title, owner, due, severity] of DEADLINES) {
    insDeadline.run(title, owner, czToIso(due), severity);
  }

  const insSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of SETTINGS) insSetting.run(key, value);

  const insUser = db.prepare('INSERT INTO users (username, name, title, email, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [username, name, title, email, role, password] of USERS) {
    insUser.run(username, name, title, email, role, hashPassword(password));
  }

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(`Databáze naplněna: ${DB_PATH}`);
for (const t of ['controls', 'risks', 'policies', 'audit_findings', 'changes', 'incidents', 'trainings', 'faqs', 'deadlines', 'settings', 'users']) {
  console.log(`  ${t}: ${count(t)}`);
}
console.log('\nVývojové účty (změňte v produkci!):');
for (const [username, , , , role, password] of USERS) {
  console.log(`  ${username} / ${password}  (${role})`);
}
