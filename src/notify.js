// E-mailové notifikace důležitých akcí ISMS.
//
// Princip outboxu: událost se nejprve uloží do tabulky notifications,
// odesílací worker ji pak doručí. Díky tomu se notifikace neztratí
// při výpadku SMTP a vzniká auditní stopa.
//
// SMTP se konfiguruje přes env: SMTP_HOST, SMTP_PORT (výchozí 587),
// SMTP_SECURE=1 pro implicitní TLS, SMTP_USER + SMTP_PASS, SMTP_FROM.
// Bez SMTP_HOST běží dev režim: notifikace se označí 'logged' a vypíší do konzole.
// SMTP_FORCE_RECIPIENT přesměruje skutečné doručení na jednu adresu (testovací
// provoz na sdíleném SMTP účtu) — původní příjemci zůstávají v předmětu i v DB.

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
  const forceRecipient = process.env.SMTP_FORCE_RECIPIENT || null;

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
  async function defaultRecipients() {
    const managers = (await db.prepare(
      "SELECT email FROM users WHERE role = 'manager' AND email IS NOT NULL",
    ).all()).map((r) => r.email);
    const extra = (await db.prepare("SELECT value FROM settings WHERE key = 'notify_recipients'").get())?.value ?? '';
    return [...new Set([...managers, ...extra.split(',').map((s) => s.trim()).filter(Boolean)])];
  }

  async function notify(event, subject, lines, recipients = null) {
    const to = filterAllowed(recipients?.length ? recipients : await defaultRecipients());
    if (to.length === 0) return;
    const body = lines.filter(Boolean).join('\n');
    const bodyHtml = renderNotificationEmail({ event, subject, lines });
    await db.prepare('INSERT INTO notifications (event, recipients, subject, body, body_html, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event, to.join(', '), `[ISMS] ${subject}`, body, bodyHtml, new Date().toISOString());
  }

  async function processOutbox() {
    const pending = await db.prepare(
      "SELECT * FROM notifications WHERE status = 'pending' ORDER BY id LIMIT 20",
    ).all();
    for (const n of pending) {
      if (!transport) {
        await db.prepare("UPDATE notifications SET status = 'logged', sent_at = ? WHERE id = ?").run(new Date().toISOString(), n.id);
        console.log(`[notifikace/dev] ${n.subject} → ${n.recipients}\n${n.body}\n`);
        continue;
      }
      try {
        await transport.sendMail({
          from,
          to: forceRecipient ?? n.recipients,
          subject: forceRecipient ? `${n.subject} (původní příjemci: ${n.recipients})` : n.subject,
          text: n.body,
          ...(n.body_html ? { html: n.body_html } : {}),
        });
        await db.prepare("UPDATE notifications SET status = 'sent', sent_at = ? WHERE id = ?").run(new Date().toISOString(), n.id);
      } catch (err) {
        await db.prepare(
          `UPDATE notifications SET attempts = attempts + 1, error = ?,
           status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END WHERE id = ?`,
        ).run(String(err.message), n.id);
      }
    }
  }

  // Denní souhrn termínů — spustí se při prvním zpracování daného dne
  async function runDailyDigest() {
    const today = new Date().toISOString().slice(0, 10);
    const last = (await db.prepare("SELECT value FROM settings WHERE key = 'notify_digest_last_run'").get())?.value;
    if (last === today) return;

    const overdue = await db.prepare(
      "SELECT id, finding, due, owner FROM audit_findings WHERE status != 'Uzavřeno' AND (status = 'Po termínu' OR due < ?) ORDER BY due",
    ).all(today);
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const reviews = await db.prepare(
      'SELECT id, name, review_due FROM controls WHERE review_due IS NOT NULL AND review_due <= ? ORDER BY review_due',
    ).all(in30);
    const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const deadlines = await db.prepare(
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

    if (lines.length) await notify('digest.daily', 'Denní přehled termínů ISMS', lines);
    await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run('notify_digest_last_run', today);
  }

  function start() {
    runDailyDigest().catch((err) => console.error('[notifikace] runDailyDigest selhal:', err));
    processOutbox().catch((err) => console.error('[notifikace] processOutbox selhal:', err));
    setInterval(() => {
      runDailyDigest().catch((err) => console.error('[notifikace] runDailyDigest selhal:', err));
      processOutbox().catch((err) => console.error('[notifikace] processOutbox selhal:', err));
    }, 30_000).unref();
    console.log(smtpConfigured
      ? `Notifikace: SMTP ${process.env.SMTP_HOST} (odesílatel ${from})`
        + (forceRecipient ? ` — VŠECHNY e-maily přesměrovány na ${forceRecipient}` : '')
      : 'Notifikace: SMTP nenakonfigurováno — dev režim (logování do konzole a outboxu)');
  }

  return { notify, start, processOutbox, runDailyDigest };
}
