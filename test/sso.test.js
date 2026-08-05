import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { roleFromClaims, isSsoEnabled } from '../src/sso.js';

describe('roleFromClaims (mapování Entra App Roles na interní roli)', () => {
  test('bez claims.roles vrací null', () => {
    assert.equal(roleFromClaims({}), null);
    assert.equal(roleFromClaims(undefined), null);
  });

  test('jedna rozpoznaná app role', () => {
    assert.equal(roleFromClaims({ roles: ['ISMS.Reader'] }), 'reader');
    assert.equal(roleFromClaims({ roles: ['ISMS.Editor'] }), 'editor');
    assert.equal(roleFromClaims({ roles: ['ISMS.Manager'] }), 'manager');
  });

  test('víc rolí najednou → vyhraje nejvyšší oprávnění', () => {
    assert.equal(roleFromClaims({ roles: ['ISMS.Reader', 'ISMS.Editor'] }), 'editor');
    assert.equal(roleFromClaims({ roles: ['ISMS.Editor', 'ISMS.Manager', 'ISMS.Reader'] }), 'manager');
  });

  test('neznámé/nepřiřazené hodnoty se ignorují', () => {
    assert.equal(roleFromClaims({ roles: ['Nejaka.Jina.Role'] }), null);
    assert.equal(roleFromClaims({ roles: ['Nejaka.Jina.Role', 'ISMS.Reader'] }), 'reader');
  });
});

describe('isSsoEnabled', () => {
  test('false, dokud nejsou nastavené všechny ENTRA_* proměnné', () => {
    const saved = {
      tenant: process.env.ENTRA_TENANT_ID,
      client: process.env.ENTRA_CLIENT_ID,
      secret: process.env.ENTRA_CLIENT_SECRET,
    };
    delete process.env.ENTRA_TENANT_ID;
    delete process.env.ENTRA_CLIENT_ID;
    delete process.env.ENTRA_CLIENT_SECRET;
    assert.equal(isSsoEnabled(), false);

    process.env.ENTRA_TENANT_ID = 't';
    process.env.ENTRA_CLIENT_ID = 'c';
    assert.equal(isSsoEnabled(), false); // chybí secret

    process.env.ENTRA_CLIENT_SECRET = 's';
    assert.equal(isSsoEnabled(), true);

    if (saved.tenant === undefined) delete process.env.ENTRA_TENANT_ID; else process.env.ENTRA_TENANT_ID = saved.tenant;
    if (saved.client === undefined) delete process.env.ENTRA_CLIENT_ID; else process.env.ENTRA_CLIENT_ID = saved.client;
    if (saved.secret === undefined) delete process.env.ENTRA_CLIENT_SECRET; else process.env.ENTRA_CLIENT_SECRET = saved.secret;
  });
});
