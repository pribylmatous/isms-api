import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { levelOf, domainCompliance } from '../src/scoring.js';

describe('levelOf', () => {
  test('nízké skóre (< 5)', () => {
    assert.equal(levelOf(1), 'Nízké');
    assert.equal(levelOf(4), 'Nízké');
  });

  test('hranice 5 je již Střední', () => {
    assert.equal(levelOf(5), 'Střední');
    assert.equal(levelOf(7), 'Střední');
  });

  test('hranice 8 je již Vysoké', () => {
    assert.equal(levelOf(8), 'Vysoké');
    assert.equal(levelOf(16), 'Vysoké');
  });
});

describe('domainCompliance', () => {
  test('prázdný katalog vrací 0 % a žádné domény', () => {
    assert.deepEqual(domainCompliance([]), { domains: [], overallPct: 0 });
  });

  test('průměruje váhy stavů (Zavedeno=1, Částečně=0.5, Chybí=0) po doménách', () => {
    const controls = [
      { domain: 'Organizační', status: 'Zavedeno' },
      { domain: 'Organizační', status: 'Chybí' },
      { domain: 'Technologická', status: 'Částečně zavedeno' },
    ];
    const { domains, overallPct } = domainCompliance(controls);
    assert.deepEqual(
      domains.sort((a, b) => a.domain.localeCompare(b.domain)),
      [
        { domain: 'Organizační', pct: 50 },
        { domain: 'Technologická', pct: 50 },
      ],
    );
    // (1 + 0 + 0.5) / 3 = 0.5 → 50 %
    assert.equal(overallPct, 50);
  });

  test('neznámý/chybějící stav se počítá jako váha 0', () => {
    const { overallPct } = domainCompliance([{ domain: 'X', status: 'Neexistující stav' }]);
    assert.equal(overallPct, 0);
  });
});
