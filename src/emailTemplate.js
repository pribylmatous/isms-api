// Vykreslení notifikačních "řádků" (viz notify.js) do HTML e-mailu.
//
// notify() dostává pole textových řádků (nadpisy končící ':', páry
// "Popisek: hodnota", odrážky '  • …' a prázdné řádky jako oddělovače
// sekcí — stejná data, jaká se posílají i jako prostý text). Tahle
// funkce je bezezbytku převede na tabulkové rozvržení s inline styly,
// protože e-mailoví klienti CSS proměnné ani <style> bloky spolehlivě
// nepodporují. Barvy jsou převzaté z css/tokens.css (gov.cz tokeny).

const COLOR = {
  text: '#3B3B3B',
  textSoft: '#5D5D5D',
  footer: '#6D6D6D',
  border: '#E7E7E7',
  bg: '#F6F6F6',
  primaryBg: '#1E5086',
  primaryText: '#1D456F',
  primaryLink: '#2362A2',
  dangerBg: '#9E0615',
  neutralBg: '#5D5D5D',
};

function accentFor(event) {
  if (event === 'risk.escalated') return COLOR.dangerBg;
  if (event.endsWith('.deleted')) return COLOR.neutralBg;
  return COLOR.primaryBg;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Rozdělí řádky do bloků: nadpis, seznam odrážek, skupina polí Popisek/hodnota, volný text.
function parseLines(lines) {
  const blocks = [];
  let group = null;

  const closeGroup = () => { group = null; };

  for (const raw of lines) {
    const line = (raw ?? '').toString();
    if (line.trim() === '') { closeGroup(); continue; }

    const bullet = line.match(/^\s*•\s*(.+)$/);
    if (bullet) {
      if (!group || group.type !== 'list') { group = { type: 'list', items: [] }; blocks.push(group); }
      group.items.push(bullet[1]);
      continue;
    }

    const field = line.match(/^([\p{L}0-9()./ ]{2,28}):\s+(\S.*)$/u);
    if (!field && line.endsWith(':')) {
      closeGroup();
      blocks.push({ type: 'heading', text: line.slice(0, -1) });
      continue;
    }
    if (field) {
      if (!group || group.type !== 'fields') { group = { type: 'fields', items: [] }; blocks.push(group); }
      group.items.push({ label: field[1], value: field[2] });
      continue;
    }

    closeGroup();
    blocks.push({ type: 'text', text: line });
  }
  return blocks;
}

function renderBlock(block) {
  if (block.type === 'heading') {
    return `<p style="margin:20px 0 8px;font-size:14px;font-weight:600;color:${COLOR.text};">${escapeHtml(block.text)}</p>`;
  }
  if (block.type === 'list') {
    const items = block.items.map((i) => `<li style="margin:0 0 4px;">${escapeHtml(i)}</li>`).join('');
    return `<ul style="margin:0 0 12px;padding-left:20px;font-size:14px;color:${COLOR.textSoft};">${items}</ul>`;
  }
  if (block.type === 'fields') {
    const rows = block.items.map((f) => `
      <tr>
        <td style="padding:3px 12px 3px 0;font-size:13px;color:${COLOR.textSoft};white-space:nowrap;vertical-align:top;">${escapeHtml(f.label)}</td>
        <td style="padding:3px 0;font-size:14px;color:${COLOR.text};vertical-align:top;">${escapeHtml(f.value)}</td>
      </tr>`).join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 12px;">${rows}</table>`;
  }
  return `<p style="margin:0 0 12px;font-size:14px;color:${COLOR.text};">${escapeHtml(block.text)}</p>`;
}

const PORTAL_URL = process.env.PORTAL_URL ?? 'http://localhost:5173';

export function renderNotificationEmail({ event, subject, lines }) {
  const accent = accentFor(event);
  const bodyHtml = parseLines(lines).map(renderBlock).join('\n');
  const generatedAt = new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });

  return `<!doctype html>
<html lang="cs">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:${COLOR.bg};font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLOR.bg};padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#FFFFFF;border-radius:8px;border:1px solid ${COLOR.border};">
            <tr>
              <td style="background:${accent};padding:16px 28px;border-radius:8px 8px 0 0;">
                <span style="color:#FFFFFF;font-size:13px;font-weight:600;letter-spacing:.3px;">ISMS PORTÁL</span>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 8px;">
                <h1 style="margin:0 0 16px;font-size:18px;line-height:1.3;color:${COLOR.primaryText};">${escapeHtml(subject)}</h1>
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 24px;border-top:1px solid ${COLOR.border};">
                <p style="margin:0;font-size:12px;line-height:1.5;color:${COLOR.footer};">
                  Automatická notifikace systému řízení bezpečnosti informací (ISO/IEC 27001).
                  Vygenerováno ${escapeHtml(generatedAt)}.<br>
                  <a href="${PORTAL_URL}" style="color:${COLOR.primaryLink};">Otevřít ISMS portál</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
