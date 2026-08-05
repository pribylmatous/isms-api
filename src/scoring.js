// Čisté výpočetní funkce bez závislosti na DB — snadno jednotkově testovatelné.

// Úroveň rizika ze skóre pravděpodobnost × dopad (1–4 každé, tedy 1–16).
export const levelOf = (score) => (score >= 8 ? 'Vysoké' : score >= 5 ? 'Střední' : 'Nízké');

// Váha stavu zavedení opatření přílohy A pro výpočet shody (viz README „Dashboard počítá živě").
export const STATUS_WEIGHT = { 'Zavedeno': 1, 'Částečně zavedeno': 0.5, 'Chybí': 0 };

// Shoda podle domén (%) a celková shoda (%) z pole opatření { domain, status }.
export function domainCompliance(controls) {
  const byDomain = {};
  for (const c of controls) {
    (byDomain[c.domain] ??= []).push(STATUS_WEIGHT[c.status] ?? 0);
  }
  const domains = Object.entries(byDomain).map(([domain, weights]) => ({
    domain,
    pct: Math.round((weights.reduce((a, b) => a + b, 0) / weights.length) * 100),
  }));
  const allWeights = controls.map((c) => STATUS_WEIGHT[c.status] ?? 0);
  const overallPct = allWeights.length
    ? Math.round((allWeights.reduce((a, b) => a + b, 0) / allWeights.length) * 100)
    : 0;
  return { domains, overallPct };
}
