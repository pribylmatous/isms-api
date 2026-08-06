// Auditní stopa: zápis do audit_log při každé vytvářející/měnící/mazací akci
// nad entitami ISMS (opatření, rizika, dokumenty, zjištění). Na rozdíl od
// notify.js (e-mailový outbox pro vybrané události) tohle je úplný,
// strojově čitelný log „kdo co kdy změnil" — viz README.

const IGNORED_FIELDS = new Set(['updated_at', 'created_at', 'file_stored']);

// Diff dvou řádků DB → { pole: [staré, nové] } jen pro pole, která se liší.
export function diffRows(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes = {};
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    const a = before?.[key] ?? null;
    const b = after?.[key] ?? null;
    if (a !== b) changes[key] = [a, b];
  }
  return changes;
}

export function createAuditLog(db) {
  async function record(req, { entity, entityId, action, before = null, after = null, label }) {
    let changes = null;
    if (action === 'update') {
      const diff = diffRows(before, after);
      if (Object.keys(diff).length === 0) return; // nic se ve skutečnosti nezměnilo
      changes = JSON.stringify(diff);
    }
    await db.prepare(`INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, label, changes, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user?.id ?? null, req.user?.name ?? null, entity, String(entityId), action, label ?? null, changes, new Date().toISOString());
  }

  return { record };
}
