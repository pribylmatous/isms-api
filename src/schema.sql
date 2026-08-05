-- Schéma databáze ISMS portálu (SQLite; přenositelné na PostgreSQL/SQL Server).
-- Datumy se ukládají jako ISO 8601 (YYYY-MM-DD), formátování řeší frontend.

CREATE TABLE IF NOT EXISTS controls (
  id         TEXT PRIMARY KEY,                 -- 'A.5.1' … dle přílohy A ISO/IEC 27001:2022
  name       TEXT NOT NULL,
  domain     TEXT NOT NULL CHECK (domain IN ('Organizační', 'Lidské zdroje', 'Fyzická bezpečnost', 'Technologická')),
  status     TEXT NOT NULL CHECK (status IN ('Zavedeno', 'Částečně zavedeno', 'Chybí')),
  owner      TEXT NOT NULL,
  review_due TEXT,                             -- termín příštího přezkoumání (NULL = nestanoven)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS risks (
  id          TEXT PRIMARY KEY,                -- 'R-01'
  name        TEXT NOT NULL,
  asset       TEXT NOT NULL,
  probability INTEGER CHECK (probability BETWEEN 1 AND 4),  -- NULL u historických záznamů bez rozkladu skóre
  impact      INTEGER CHECK (impact BETWEEN 1 AND 4),
  score       INTEGER NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('Nízké', 'Střední', 'Vysoké')),
  owner       TEXT NOT NULL,
  treatment   TEXT,
  status      TEXT NOT NULL DEFAULT 'Otevřené' CHECK (status IN ('Otevřené', 'Uzavřené')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('Řídicí dokumentace', 'Postupy', 'Záznamy')),
  version     TEXT NOT NULL,
  owner       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('Návrh', 'K revizi', 'Schváleno')),
  updated_at  TEXT NOT NULL,
  file_name   TEXT,               -- původní název nahraného souboru
  file_stored TEXT,               -- náhodný název pod kterým je soubor uložen v uploads/
  file_size   INTEGER,            -- bajty
  file_mime   TEXT
);

CREATE TABLE IF NOT EXISTS audit_findings (
  id         TEXT PRIMARY KEY,                 -- 'F-14'
  finding    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('Neshoda', 'Doporučení', 'Pozorování')),
  status     TEXT NOT NULL DEFAULT 'Nové' CHECK (status IN ('Nové', 'V řešení', 'Po termínu', 'Uzavřeno')),
  due        TEXT NOT NULL,
  owner      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Řízení změn (ITIL, viz opatření A.8.32 „Řízení změn"). Odlehčený registr —
-- bez formálních schvalovacích bran (CAB) či SLA časovačů, stejná úroveň
-- podrobnosti jako audit_findings.
CREATE TABLE IF NOT EXISTS changes (
  id               TEXT PRIMARY KEY,             -- 'CHG-01'
  title            TEXT NOT NULL,
  description      TEXT,
  type             TEXT NOT NULL CHECK (type IN ('Standardní', 'Normální', 'Nouzová')),
  risk_level       TEXT NOT NULL CHECK (risk_level IN ('Nízké', 'Střední', 'Vysoké')),
  status           TEXT NOT NULL DEFAULT 'Návrh'
                     CHECK (status IN ('Návrh', 'Ke schválení', 'Schváleno', 'Naplánováno', 'Realizováno', 'Uzavřeno', 'Zamítnuto')),
  owner            TEXT NOT NULL,
  planned_date     TEXT,                         -- plánovaný termín realizace
  implemented_date TEXT,                         -- skutečný termín realizace
  control_id       TEXT REFERENCES controls(id) ON DELETE SET NULL,  -- volitelná vazba na opatření přílohy A
  risk_id          TEXT REFERENCES risks(id) ON DELETE SET NULL,     -- volitelná vazba na riziko
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Řízení incidentů bezpečnosti informací (ITIL, viz opatření A.5.24–A.5.30).
CREATE TABLE IF NOT EXISTS incidents (
  id           TEXT PRIMARY KEY,                 -- 'INC-01'
  title        TEXT NOT NULL,
  description  TEXT,
  category     TEXT NOT NULL CHECK (category IN ('Narušení dat', 'Malware', 'Neoprávněný přístup', 'Dostupnost/výpadek', 'Phishing', 'Jiné')),
  priority     TEXT NOT NULL CHECK (priority IN ('Nízká', 'Střední', 'Vysoká', 'Kritická')),
  status       TEXT NOT NULL DEFAULT 'Nové' CHECK (status IN ('Nové', 'V řešení', 'Eskalováno', 'Vyřešeno', 'Uzavřeno')),
  reported_by  TEXT NOT NULL,
  owner        TEXT NOT NULL,
  occurred_at  TEXT NOT NULL,                     -- kdy incident nastal
  resolved_at  TEXT,
  resolution   TEXT,                              -- řešení / kořenová příčina
  control_id   TEXT REFERENCES controls(id) ON DELETE SET NULL,
  risk_id      TEXT REFERENCES risks(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trainings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  audience     TEXT NOT NULL,                     -- popisek odvozený z target_roles (viz routes.js audienceLabel)
  due          TEXT NOT NULL,
  pct          INTEGER NOT NULL DEFAULT 0 CHECK (pct BETWEEN 0 AND 100),  -- statická hodnota; ignoruje se, má-li školení content
  content      TEXT,                              -- JSON kvíz [{ q, options: [...], correct: index }] — NULL = bez interaktivního obsahu
  target_roles TEXT NOT NULL DEFAULT '["reader","editor","manager"]'  -- JSON pole rolí (LOV), pro koho je školení určené
);

-- Výsledek absolvování interaktivního školení konkrétním uživatelem
-- (jeden aktuální pokus na dvojici školení/uživatel — opakování přepíše skóre).
CREATE TABLE IF NOT EXISTS training_completions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  training_id  INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score        INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  passed       INTEGER NOT NULL CHECK (passed IN (0, 1)),
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (training_id, user_id)
);

CREATE TABLE IF NOT EXISTS faqs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer   TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deadlines (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  title    TEXT NOT NULL,
  owner    TEXT NOT NULL,
  due      TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'neutral' CHECK (severity IN ('neutral', 'warn', 'danger'))
);

-- Konfigurace (termín recertifikace, cíl shody apod.)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Uživatelé a role.
-- reader = jen čtení, editor = přidávání a úpravy, manager = navíc mazání.
-- Při přechodu na SSO (Entra ID) se role mapují z AD skupin, tabulka zůstává.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  title         TEXT,
  email         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('reader', 'editor', 'manager')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),  -- "smazání" účtu = deaktivace, ne DELETE (zachová audit_log/training_completions)
  entra_oid     TEXT UNIQUE,                     -- Entra ID object id (SSO účty); NULL u čistě lokálních účtů
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Auditní stopa: kdo/co/kdy nad entitami ISMS. Na rozdíl od notifications
-- (outbox pro e-maily o vybraných událostech) zaznamenává úplně každou
-- vytvářející/měnící/mazací akci, u update navíc s diffem změněných polí.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name  TEXT,                              -- snímek jména v době akce (přežije smazání účtu)
  entity     TEXT NOT NULL,                     -- 'control' | 'risk' | 'policy' | 'finding'
  entity_id  TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  label      TEXT,                              -- krátký popisek entity pro přehled
  changes    TEXT                               -- JSON { pole: [staré, nové] }, jen pro action='update'
);

-- Outbox e-mailových notifikací: záznam vzniká při důležité akci,
-- odesílací worker ho zpracuje (SMTP) nebo v dev režimu zaloguje.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,               -- např. 'risk.created', 'digest.daily'
  recipients TEXT NOT NULL,               -- e-maily oddělené čárkou
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,               -- prostý text (fallback pro klienty bez HTML)
  body_html  TEXT,                        -- vykreslený branded HTML e-mail (src/emailTemplate.js)
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'logged', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT
);
