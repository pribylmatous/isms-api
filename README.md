# ISMS API

Backend ISMS portálu — Node.js (Express 5) + PostgreSQL (`pg`). Data z prototypu
jsou převedena seedem do databáze.

## Spuštění

```bash
npm install
# Postgres musí běžet a DATABASE_URL v .env ukazovat na prázdnou/existující DB —
# schéma (src/schema.sql) se založí samo při startu (openDb() je idempotentní).
npm run seed   # vytvoří/naplní DB daty z prototypu (idempotentní — tabulky vyprázdní a naplní znovu)
npm run dev    # server s auto-restartem na http://localhost:3001
```

Konfigurace: `PORT` (výchozí 3001), `DATABASE_URL` (`postgres://user:pass@host:5432/isms`).

Existující SQLite `isms.db` z dřívější verze lze jednorázově převést pomocí
`node src/migrate-sqlite-to-pg.js [cesta-k-isms.db]` (viz komentář v souboru).

## Testy

```bash
npm test   # node --test --test-concurrency=1 — vestavěný test runner, žádná další závislost
```

Testy potřebují samostatnou `TEST_DATABASE_URL` (v `.env`) — **ne** stejnou DB jako
`DATABASE_URL`, protože `test/helpers.js` před každým použitím všechny tabulky
vyprázdní. Testy (`test/*.test.js`) běží proti skutečné Express aplikaci
(`src/app.js`, oddělené od síťového naslouchání v `server.js`) — žádné mockování.
`--test-concurrency=1` je nutné, protože na rozdíl od dřívějšího SQLite
(`openDb(':memory:')`, plná izolace na soubor) teď všechny testovací soubory sdílí
jednu Postgres DB, kterou si každý navzájem promazává. Pokrývají:

- **`scoring.test.js`** — čisté funkce `levelOf`/`domainCompliance` (`src/scoring.js`).
- **`auth.test.js`** — přihlášení/odhlášení, 401 bez session, role guardy (403),
  deaktivovaný účet se nepřihlásí.
- **`risks.test.js`** — dopočet skóre/úrovně serverem a notifikační eventy
  (`risk.created`/`risk.escalated`/`risk.closed`/`risk.deleted`) v tabulce `notifications`.
- **`policies.test.js`** — nahrání/nahrazení/smazání souboru dokumentu na disku
  (`src/storage.js`) přes skutečný `multipart/form-data` request.
- **`audit.test.js`** — diff funkce `src/audit.js` a zápis/filtrování `audit_log` (viz níže).
- **`changes.test.js`** / **`incidents.test.js`** — ITIL registry: role guardy, vazby na
  opatření/riziko (vč. neplatné reference a `ON DELETE SET NULL` při smazání vazby).
- **`training.test.js`** — interaktivní kvíz školení: otázky bez správných odpovědí,
  vyhodnocení, živě počítané `pct`, upsert při opakování, nezávislost mezi uživateli;
  a administrace (jen manager): validace otázek/rolí, editace, cílení podle role
  (viditelnost, 403 mimo roli, pct/roster jen za cílovou skupinu), mazání s cascade.
- **`users.test.js`** — správa uživatelů (jen manager): vytvoření/úprava/reset hesla,
  duplicitní jméno a krátké heslo vrací 400, pojistky proti sebe-deaktivaci a odebrání
  posledního manažera, okamžité zneplatnění session při deaktivaci, audit log.

`test/helpers.js` poskytuje `startTestServer()` (aplikace na efemérním portu)
a jednoduchého klienta, který si mezi requesty drží session cookie jako prohlížeč.

## Schéma databáze (src/schema.sql)

| Tabulka | Obsah | Poznámka |
| --- | --- | --- |
| `controls` | Kompletní katalog 93 opatření přílohy A (`src/catalog.js`) | PK = ID opatření (`A.5.1`), doména, stav, `review_due` pro termín přezkumu |
| `risks` | Registr rizik | `probability`/`impact` (1–4) → `score`, `level`; u seedovaných záznamů NULL (návrh obsahoval jen skóre) |
| `policies` | Řízená dokumentace | verze, stav Návrh → K revizi → Schváleno; `file_*` sloupce viz níže |
| `audit_findings` | Zjištění z auditů | stav Nové → V řešení → Uzavřeno / Po termínu |
| `changes` | Řízení změn (ITIL, A.8.32) | typ, riziko změny, volitelná vazba na opatření/riziko |
| `incidents` | Řízení incidentů bezpečnosti informací (ITIL, A.5.24–A.5.30) | kategorie, priorita, volitelná vazba na opatření/riziko; `assigned_to_user_id` (FK `users`) — viz „Workflow incidentu" níže |
| `incident_activity` | Časová osa jednoho incidentu | přechody stavu + komentáře v jednom feedu, viz „Workflow incidentu" níže |
| `audit_log` | Auditní stopa (kdo/co/kdy) | viz sekce „Auditní stopa" níže |
| `trainings` | Školení | `content` (JSON kvíz) u interaktivních školení; `target_roles` (JSON LOV rolí) určuje cílovou skupinu |
| `training_completions` | Výsledky absolvování kvízu | jeden aktuální pokus na uživatele a školení |
| `faqs` | Nejčastější dotazy | pořadí přes `position` |
| `deadlines` | Nejbližší termíny | pro dashboard |
| `settings` | Konfigurace | termín recertifikace, cíl shody |

Datumy/časová razítka jsou `TEXT` v ISO 8601 — seed je převádí z českého formátu
návrhu; `created_at`/`updated_at`/`at` apod. appka vždy generuje v JS
(`new Date().toISOString()`) a posílá jako parametr, ne jako SQL default (Postgres
nemá SQLite `datetime('now')`). Stavy hlídají `CHECK` constrainty.

## Přihlašování a role

Lokální účty se session cookie (`isms_session`, HttpOnly, platnost 8 h).
Hesla jsou hashovaná (scrypt). Role:

| Role | Oprávnění |
| --- | --- |
| `reader` | jen čtení |
| `editor` | čtení + přidávání a úpravy (POST/PUT) |
| `manager` | vše včetně mazání (DELETE) |

Vývojové účty ze seedu (**v produkci změnit / nahradit SSO Entra ID**):
`j.kovarova / Isms.2026` (manager), `p.dvorak / Editor.2026` (editor),
`zamestnanec / Cdv.2026` (reader).

Při přechodu na SSO se vymění pouze login endpoint v `src/auth.js` —
guard, `requireRole` i tabulka `users` (role mapované z AD skupin) zůstávají.

Až je SSO v produkci ověřené, `DISABLE_LOCAL_LOGIN=1` (v `.env`) vypne lokální
přihlášení úplně (`POST /api/auth/login` vrací 404, `GET /api/auth/config`
hlásí `localLoginEnabled: false`, frontend skryje formulář) — tím padnou
i seedované dev účty jako cesta dovnitř. Příznak se **ignoruje**, dokud
nejsou nastavené všechny `ENTRA_*` proměnné (`isLocalLoginEnabled()` v
`src/auth.js`), aby překlep v konfiguraci nezamkl administraci úplně bez
cesty k přihlášení.

### Správa uživatelů (jen `manager`)

```
GET    /api/users        seznam účtů (bez password_hash)
POST   /api/users        { username, name, title?, email?, role, password } (heslo ≥ 8 znaků)
PUT    /api/users/:id    částečná úprava; password nepovinné (reset), active: true/false (de/aktivace)
```

Účty se **nemažou** (`DELETE` endpoint neexistuje) — `active = 0` je jediná
cesta, jak účet zneškodnit, protože hard delete by kvůli cizím klíčům smazal
i `training_completions` uživatele a osiřel jeho `audit_log` záznamy (přesně
to, co má auditní stopa uchovávat). Deaktivace má okamžitý efekt: `login`
i `userForToken` (session guard) filtrují `active = 1`, takže už přihlášený
uživatel je při dalším requestu odhlášen (a jeho `sessions` se navíc rovnou
smažou). Pojistky proti zablokování administrace: nelze deaktivovat **sám
sebe** a nelze deaktivovat/degradovat **posledního aktivního manažera**.

## Endpointy

Všechny endpointy kromě `/api/health` a `/api/auth/*` vyžadují přihlášení (jinak 401);
nedostatečná role vrací 403.

```
GET    /api/health                   stav serveru (bez přihlášení)
POST   /api/auth/login               { username, password } → nastaví cookie, vrátí uživatele
POST   /api/auth/logout              zruší session
GET    /api/auth/me                  přihlášený uživatel
GET    /api/users                    (jen manager) seznam účtů bez password_hash
POST   /api/users                    (jen manager) viz „Správa uživatelů" výše
PUT    /api/users/:id                (jen manager) viz „Správa uživatelů" výše
GET    /api/dashboard                KPI, shoda domén, upozornění, termíny (počítáno živě z DB)

GET    /api/controls                 opatření přílohy A
PUT    /api/controls/:id             změna stavu / vlastníka / termínu přezkumu
GET    /api/controls/export.xlsx     export SoA (XLSX, sloupec vlastníka s rozbalovacím seznamem)
GET    /api/controls/owners          číselník vlastníků (LOV, viz níže)

GET    /api/risks
POST   /api/risks                    { name, asset, probability, impact, owner, treatment? }
PUT    /api/risks/:id                částečná aktualizace, přepočet skóre
DELETE /api/risks/:id
GET    /api/risks/owners             číselník vlastníků (LOV, viz níže)

GET    /api/policies
POST   /api/policies                 multipart/form-data: { name, category, owner, file? } → stav „Návrh", verze 1.0
PUT    /api/policies/:id             multipart/form-data; file je nepovinný (nahrazuje připojený dokument)
DELETE /api/policies/:id             smaže i uložený soubor
GET    /api/policies/:id/file        stažení připojeného dokumentu
GET    /api/policies/owners          číselník vlastníků (LOV, viz níže)

GET    /api/findings
POST   /api/findings                 { finding, type, due, owner } → stav „Nové"
PUT    /api/findings/:id
DELETE /api/findings/:id
GET    /api/findings/owners          číselník vlastníků (LOV, viz níže)

GET    /api/changes
POST   /api/changes                  { title, type, risk_level, owner, planned_date?, control_id?, risk_id? }
PUT    /api/changes/:id
DELETE /api/changes/:id
GET    /api/changes/owners           číselník vlastníků (LOV, viz níže)

GET    /api/incidents
GET    /api/incidents/:id
POST   /api/incidents                { title, category, priority, reported_by, owner, occurred_at, control_id?, risk_id? }
PUT    /api/incidents/:id            popisná pole (název, kategorie, priorita, …) — status jde jen přes workflow akce níže
DELETE /api/incidents/:id
GET    /api/incidents/owners         číselník vlastníků (LOV, viz níže)
GET    /api/incidents/:id/activity   časová osa (přechody stavu + komentáře), viz „Workflow incidentu" níže
POST   /api/incidents/:id/comments   { text } → přidá poznámku do časové osy, beze změny stavu
POST   /api/incidents/:id/assign     { user_id } → nastaví řešitele; z „Nové" navíc přejde na „Přiřazeno"
POST   /api/incidents/:id/start      Přiřazeno → V řešení
POST   /api/incidents/:id/pause      { reason } → V řešení → Pozastaveno
POST   /api/incidents/:id/resume     Pozastaveno → V řešení
POST   /api/incidents/:id/escalate   { note? } → (V řešení|Pozastaveno) → Eskalováno
POST   /api/incidents/:id/resolve    { resolution } → (V řešení|Eskalováno) → Vyřešeno
POST   /api/incidents/:id/close      Vyřešeno → Uzavřeno
POST   /api/incidents/:id/reopen     { reason } → (Vyřešeno|Uzavřeno) → V řešení, vyčistí resolution/resolved_at
GET    /api/users/assignable         { id, name }[] aktivních uživatelů — pro výběr řešitele (komukoli přihlášenému)

GET    /api/trainings                jen školení pro roli přihlášeného uživatele (manager vidí všechna);
                                      pct živě dopočtené vůči cílové skupině, + myCompletion uživatele
GET    /api/trainings/:id/quiz       otázky BEZ správných odpovědí; 403 mimo cílovou roli, 404 bez obsahu
POST   /api/trainings/:id/complete   { answers: [index, …] } → vyhodnotí, uloží výsledek (upsert), vrátí skóre
GET    /api/trainings/:id            plný obsah vč. správných odpovědí a target_roles — pro editaci (jen manager)
POST   /api/trainings                { name, target_roles: [role, …], due, questions: [{ q, options, correct }] } (jen manager)
PUT    /api/trainings/:id            target_roles/questions nepovinné — bez nich se stávající hodnota nemění (jen manager)
DELETE /api/trainings/:id            smaže i výsledky uživatelů, ON DELETE CASCADE (jen manager)
GET    /api/trainings/:id/completions  roster: stav/skóre uživatelů v cílové skupině školení (jen manager)
GET    /api/faqs

GET    /api/notifications            outbox e-mailových notifikací (jen manager)
GET    /api/audit-log                auditní stopa, ?entity=&entityId=&limit= (jen manager)
```

Chyby vrací JSON `{ "error": "…" }` se stavovým kódem 400/404/500.

## Ukládání dokumentů (src/storage.js)

Soubory dokumentů (`policies`) se ukládají na disk do `uploads/` (lze přepsat
proměnnou `ISMS_UPLOADS`), pod náhodným názvem (`crypto.randomUUID()` +
přípona) — původní název, velikost a MIME typ se drží v DB (`file_name`,
`file_size`, `file_mime`; interní `file_stored` se klientovi nevrací).
Povolené přípony: `.pdf`, `.doc`, `.docx`, `.odt`; limit 20 MB. Nahrazení
souboru (PUT s novým `file`) smaže starý soubor z disku; smazání dokumentu
smaže i jeho soubor. Metadata lze upravit i bez přiložení nového souboru —
prázdný `<input type="file">` se pozná podle nulové velikosti a ignoruje.

## Číselník vlastníků (LOV)

`src/lov.js` obsahuje jeden sdílený seznam osob/útvarů (`OWNERS`), který se
nabízí jako předdefinovaný výběr namísto volného textu ve všech formulářích
(rizika, opatření, dokumenty, zjištění, změny, incidenty) i v exportu SoA
(datová validace buňky v Excelu). Existující hodnota mimo seznam (starší
záznam) se ve formuláři zobrazí jako doplňková volba, aby nedošlo k jejímu
tichému přepsání.

## Řízení změn a incidentů (ITIL)

`changes` a `incidents` jsou odlehčené registry na stejné úrovni podrobnosti
jako `audit_findings` — bez formálních schvalovacích bran (CAB) nebo SLA
časovačů. Obě tabulky mají volitelné `control_id`/`risk_id` (`ON DELETE SET
NULL` — smazání navázaného opatření/rizika vazbu jen zruší, záznam změny/
incidentu zůstane). Odpovídají opatřením přílohy A **A.8.32** (Řízení změn)
a **A.5.24–A.5.30** (Řízení incidentů bezpečnosti informací), která už
katalog obsahuje. Notifikace a auditní stopa fungují stejně jako u ostatních
registrů (`change.created`/`change.status`/`change.deleted`,
`incident.created`/`incident.status`/`incident.assigned`/`incident.deleted`).

### Workflow incidentu (ticketDetail)

Na rozdíl od `changes` má `incidents` navíc plnohodnotný stavový workflow —
`status` se mění výhradně přes akce v `src/routes.js` (`INCIDENT_TRANSITIONS`),
ne přes generický `PUT` (ten teď mění jen popisná pole): `Nové → Přiřazeno →
V řešení ⇄ Pozastaveno → (Eskalováno →) Vyřešeno → Uzavřeno`, s možností
`reopen` z `Vyřešeno`/`Uzavřeno` zpět na `V řešení`. Každá akce ověří, že
přechod je z aktuálního stavu platný (409 jinak), a zapíše řádek do
`incident_activity` — časové osy konkrétního incidentu, co kombinuje systémové
přechody (`type: 'status_change'`/`'assignment'`) i ruční poznámky
(`type: 'comment'`, `POST .../comments`) v jednom feedu řazeném podle `at`
(`GET .../activity`). Řešitel (`assigned_to_user_id`, FK na `users`) je
nezávislý na `owner` (LOV odpovědná osoba/útvar, reporting pohled, stejný
princip jako u ostatních registrů) — přiřazení akcí `assign` jde provést
kdykoli mimo `Vyřešeno`/`Uzavřeno`, i opakovaně (přeřazení jinému řešiteli
během `V řešení` stav nemění). Pro výběr řešitele existuje odlehčený
`GET /api/users/assignable` (jen `{ id, name }`, dostupný komukoli
přihlášenému) — na rozdíl od `GET /api/users` (jen manažer, plná data).

## Interaktivní školení

Školení s vyplněným sloupcem `content` (JSON pole otázek `{ q, options,
correct }`) lze v portálu skutečně absolvovat: `GET .../quiz` vrátí otázky
**bez** `correct` (ty se nikdy neposílají klientovi předem), `POST
.../complete` odpovědi ověří na serveru a uloží výsledek do
`training_completions` (upsert — opakování přepíše předchozí pokus stejného
uživatele). Práh úspěšnosti je `TRAINING_PASS_THRESHOLD` v `routes.js`
(výchozí 75 %).

**Cílová skupina je LOV rolí, ne volný text** — `target_roles` (JSON pole
`'reader'`/`'editor'`/`'manager'`, `ALL_ROLES`/`validateTargetRoles` v
`routes.js`) určuje, komu se školení vůbec zobrazí: `GET /api/trainings`
readerovi/editorovi vrátí jen školení cílená na jejich roli, zatímco
`manager` vidí a spravuje úplně všechna (potřebuje k nim mít přístup bez
ohledu na cílovou skupinu). `GET/POST .../quiz`/`.../complete` mimo roli
vrací 403. `pct` a roster (`.../completions`) se počítají jen vůči
uživatelům v cílové skupině, ne vůči všem uživatelům portálu. Čitelný popisek
(`audience`, např. „Čtenáři, Editoři" nebo „Všichni uživatelé") se z
`target_roles` odvozuje serverem (`audienceLabel`) — klient jej neposílá.

**Administrace (jen `manager`)** — `POST`/`PUT`/`DELETE /api/trainings`
vytvářejí/upravují/mažou školení vč. otázek (`validateQuestions` v
`routes.js` ověří, že každá otázka má text, alespoň dvě neprázdné možnosti
a platný index správné odpovědi). `GET /api/trainings/:id` vrací plný obsah
**vč.** `correct` a `targetRoles` — jen pro předvyplnění formuláře úpravy,
na rozdíl od `GET .../quiz` určeného pro absolvování. `GET .../completions`
je roster: stav a skóre uživatelů v cílové skupině (LEFT JOIN — kdo kvíz
nezahájil, má `score`/`passed`/`completedAt` `null`).

## E-mailové notifikace

Důležité akce vytvářejí záznam v **outboxu** (tabulka `notifications`); odesílací
worker (běží každých 30 s) je doručuje přes SMTP. Manažer outbox vidí na
`GET /api/notifications` — pokrývá ale jen vybrané e-mail-hodné události,
ne úplnou historii změn (ta je v `audit_log`, viz níže).

**Notifikované události:** nové riziko, eskalace rizika na Vysoké, uzavření
a smazání rizika; nové zjištění, každá změna stavu zjištění, smazání; nový
dokument, změna stavu dokumentu (schválení/revize), smazání; změna stavu
opatření přílohy A. Navíc **denní souhrn** (jednou denně): zjištění po termínu,
opatření s přezkoumáním do 30 dnů a termíny v příštích 7 dnech.

**Příjemci:** uživatelé s rolí `manager` (sloupec `users.email`)
+ volitelně `settings.notify_recipients` (e-maily oddělené čárkou).

**Pojistka pro testovací provoz:** `NOTIFY_ALLOWED_DOMAINS` (v `.env`,
domény oddělené čárkou) omezí odesílání jen na vyjmenované domény —
adresy mimo ně se zahodí a zalogují. Aktuálně nastaveno na `expect-it.cz`;
v produkci řádek odeberte. Všechny vývojové účty mají testovací adresu
`mpribyl@expect-it.cz`.

**Konfigurace SMTP** (env proměnné; bez `SMTP_HOST` běží dev režim —
notifikace se označí `logged` a vypíší do konzole serveru):

```
SMTP_HOST=smtp.cdv.cz
SMTP_PORT=587           # výchozí
SMTP_SECURE=1           # jen pro implicitní TLS (port 465)
SMTP_USER=isms@cdv.cz
SMTP_PASS=***
SMTP_FROM="ISMS Portál <isms@cdv.cz>"
```

Neúspěšné odeslání se opakuje (max 3 pokusy), pak `failed` s uloženou chybou.

E-maily se odesílají jako HTML (branded šablona v `src/emailTemplate.js`, tokeny
gov.cz designu) s prostým textem jako fallback pro klienty bez HTML. Šablona
rozpozná nadpisy, dvojice „Popisek: hodnota" a odrážkové seznamy v řádcích
předaných do `notifier.notify(...)` a podle typu události (`risk.escalated`
červená, `*.deleted` šedá, ostatní modrá) obarví záhlaví. Vykreslené HTML se
ukládá do `notifications.body_html` vedle prostého textu.

## Auditní stopa (src/audit.js)

Každá vytvářející/měnící/mazací akce nad opatřeními, riziky, dokumenty a
zjištěními zapisuje řádek do `audit_log`: kdo (`user_id`/`user_name` —
jméno je snímek v době akce, přežije i pozdější smazání účtu), kdy (`at`),
nad čím (`entity`/`entity_id`) a jakou akcí (`create`/`update`/`delete`).
U `update` navíc `changes` — JSON `{ pole: [staré, nové] }` jen pro pole,
která se skutečně změnila (interní sloupce jako `updated_at`/`file_stored`
se ignorují); pokud request nic nezměnil, žádný záznam nevznikne.

Na rozdíl od `notifications` (outbox pro vybrané e-mailové události) jde
o úplnou historii — pokrývá i změny, které notifikaci nevyvolají (např.
přejmenování rizika beze změny stavu). Vidí ji jen `manager`, na
`GET /api/audit-log` (frontend: sekce „Auditní stopa").

## Dashboard počítá živě

- **Shoda domén** = průměr vah stavů opatření (Zavedeno 1, Částečně 0,5, Chybí 0).
  Čísla se proto liší od statického návrhu — odrážejí skutečný stav 14 seedovaných opatření.
- **Upozornění** se generují z dat: opatření s přezkumem do 30 dnů, zjištění po termínu.

## Další kroky

Frontend napojen, SSO (Entra ID, viz `src/sso.js`) i přechod na PostgreSQL hotové.
Hotovo i rate limiting na `/api/auth/login` (`src/rateLimit.js`) a vypnutí
lokálních dev účtů přes `DISABLE_LOCAL_LOGIN=1` (viz „Přihlašování a role"
výše) — zbývá to v produkci skutečně nastavit, až bude SSO ověřené.
Zbývá z pre-prod seznamu: reálné SMTP, produkční build + hosting frontendu, TLS,
proces supervisor místo `node --watch`, monitoring.
