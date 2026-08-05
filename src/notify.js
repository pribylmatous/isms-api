// E-mailové notifikace důležitých akcí ISMS.
//
// Princip outboxu: událost se nejprve uloží do tabulky notifications,
// odesílací worker ji pak doručí. Díky tomu se notifikace neztratí
// při výpadku SMTP a vzniká auditní stopa.
//
// SMTP se konfiguruje přes env: SMTP_HOST, SMTP_PORT (výchozí 587),
// SMTP_SECURE=1 pro implicitní TLS, SMTP_USER + SMTP_PASS, SMTP_FROM.
// Bez SMTP_HOST běží dev režim: notifikace se označí 'logged' a vypíší do konzole.

import nodemailer from 'nodemailer';
import { renderNotificationEmail } from './emailTemplate.js';

const MAX_ATTEMPTS = 3;

export function createNotifier(db) {
  const smtpConfigured = Boolean(process.env.SMTP_HOST);
  const transport = smtpConfigured
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === '1',
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
        // Pro interní servery se self-signed certifikátem: SMTP_TLS_INSECURE=1
        tls: process.env.SMTP_TLS_INSECURE === '1' ? { rejectUnauthorized: false } : undefined,
      })
    : null;
  const from = process.env.SMTP_FROM ?? 'ISMS Portál <isms@cdv.cz>';

  // Pojistka pro testovací provoz: NOTIFY_ALLOWED_DOMAINS (čárkami oddělené domény)
  // omezí příjemce jen na vyjmenované domény. Ostatní adresy se zahodí (s logem).
  const allowedDomains = (process.env.NOTIFY_ALLOWED_DOMAINS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  function filterAllowed(emails) {
    if (allowedDomains.length === 0) return emails;
    const ok = [];
    for (const e of emails) {
      if (allowedDomains.some((d) => e.toLowerCase().endsWith('@' + d))) ok.push(e);
      else console.warn(`[notifikace] Příjemce ${e} zahozen — mimo povolené domény (${allowedDomains.join(', ')})`);
    }
    return ok;
  }

  // Výchozí příjemci: manažeři ISMS + volitelně settings.notify_recipients (čárkami)
  function defaultRecipients() {
    const managers = db.prepare(
      "SELECT email FROM users WHERE role = 'manager' AND email IS NOT NULL",
    ).all().map((r) => r.email);
    const extra = db.prepare("SELECT value FROM settings WHERE key = 'notify_recipients'").get()?.value ?? '';
    return [...new Set([...managers, ...extra.split(',').map((s) => s.trim()).filter(Boolean)])];
  }

  function notify(event, subject, lines, recipients = null) {
    const to = filterAllowed(recipients?.length ? recipients : defaultRecipients());
    if (to.length === 0) return;
    const body = lines.filter(Boolean).join('\n');
    const bodyHtml = renderNotificationEmail({ event, subject, lines });
    db.prepare('INSERT INTO notifications (event, recipients, subject, body, body_html) VALUES (?, ?, ?, ?, ?)')
      .run(event, to.join(', '), `[ISMS] ${subject}`, body, bodyHtml);
  }

  async function processOutbox() {
    const pending = db.prepare(
      "SELECT * FROM notifications WHERE status = 'pending' ORDER BY id LIMIT 20",
    ).all();
    for (const n of pending) {
      if (!transport) {
        db.prepare("UPDATE notifications SET status = 'logged', sent_at = datetime('now') WHERE id = ?").run(n.id);
        console.log(`[notifikace/dev] ${n.subject} → ${n.recipients}\n${n.body}\n`);
        continue;
      }
      try {
        await transport.sendMail({
          from, to: n.recipients, subject: n.subject, text: n.body,
          ...(n.body_html ? { html: n.body_html } : {}),
        });
        db.prepare("UPDATE notifications SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(n.id);
      } catch (err) {
        db.prepare(
          `UPDATE notifications SET attempts = attempts + 1, error = ?,
           status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END WHERE id = ?`,
        ).run(String(err.message), n.id);
      }
    }
  }

  // Denní souhrn termínů — spustí se při prvním zpracování daného dne
  function runDailyDigest() {
    const today = new Date().toISOString().slice(0, 10);
    const last = db.prepare("SELECT value FROM settings WHERE key = 'notify_digest_last_run'").get()?.value;
    if (last === today) return;

    const overdue = db.prepare(
      "SELECT id, finding, due, owner FROM audit_findings WHERE status != 'Uzavřeno' AND (status = 'Po termínu' OR due < ?) ORDER BY due",
    ).all(today);
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const reviews = db.prepare(
      'SELECT id, name, review_due FROM controls WHERE review_due IS NOT NULL AND review_due <= ? ORDER BY review_due',
    ).all(in30);
    const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const deadlines = db.prepare(
      'SELECT title, owner, due FROM deadlines WHERE due BETWEEN ? AND ? ORDER BY due',
    ).all(today, in7);

    const lines = [];
    if (overdue.length) {
      lines.push('Nápravná opatření po termínu:');
      lines.push(...overdue.map((f) => `  • ${f.id} ${f.finding} (termín ${f.due}, ${f.owner})`));
    }
    if (reviews.length) {
      lines.push('', 'Opatření s přezkoumáním do 30 dnů:');
      lines.push(...reviews.map((c) => `  • ${c.id} ${c.name} (do ${c.review_due})`));
    }
    if (deadlines.length) {
      lines.push('', 'Termíny v příštích 7 dnech:');
      lines.push(...deadlines.map((d) => `  • ${d.due} ${d.title} (${d.owner})`));
    }

    if (lines.length) notify('digest.daily', 'Denní přehled termínů ISMS', lines);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('notify_digest_last_run', today);
  }

  function start() {
    runDailyDigest();
    processOutbox();
    setInterval(() => {
      runDailyDigest();
      processOutbox();
    }, 30_000).unref();
    console.log(smtpConfigured
      ? `Notifikace: SMTP ${process.env.SMTP_HOST} (odesílatel ${from})`
      : 'Notifikace: SMTP nenakonfigurováno — dev režim (logování do konzole a outboxu)');
  }

  return { notify, start, processOutbox, runDailyDigest };
}
