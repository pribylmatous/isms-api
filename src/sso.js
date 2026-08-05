// Přihlášení přes Entra ID (Azure AD), OIDC authorization code flow + PKCE.
// Role se čte z App Roles v ID tokenu (claims.roles) — žádné volání Graph API.
// Bez ENTRA_TENANT_ID/ENTRA_CLIENT_ID/ENTRA_CLIENT_SECRET je SSO vypnuté a
// portál běží jen s lokálními účty (viz auth.js).

import * as client from 'openid-client';

const PENDING_TTL_MS = 10 * 60 * 1000; // čas na dokončení přihlášení u Microsoftu

// App role → interní role. Hodnoty musí přesně odpovídat "value" app rolí
// definovaných v Azure app registration (Enterprise Applications → Users and groups).
const APP_ROLE_MAP = {
  'ISMS.Manager': 'manager',
  'ISMS.Editor': 'editor',
  'ISMS.Reader': 'reader',
};
const ROLE_PRECEDENCE = ['manager', 'editor', 'reader'];

export function isSsoEnabled() {
  return Boolean(process.env.ENTRA_TENANT_ID && process.env.ENTRA_CLIENT_ID && process.env.ENTRA_CLIENT_SECRET);
}

// Víc app rolí přiřazených jednomu uživateli → vyhraje nejvyšší oprávnění.
// Neznámé/nepřiřazené role se ignorují; bez rozpoznané role vrací null.
export function roleFromClaims(claims) {
  const roles = Array.isArray(claims?.roles) ? claims.roles : [];
  const mapped = new Set(roles.map((r) => APP_ROLE_MAP[r]).filter(Boolean));
  return ROLE_PRECEDENCE.find((r) => mapped.has(r)) ?? null;
}

let configPromise = null;

function getConfig() {
  if (!isSsoEnabled()) throw new Error('SSO není nakonfigurováno (chybí ENTRA_* proměnné)');
  if (!configPromise) {
    const issuer = new URL(`https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/v2.0`);
    configPromise = client.discovery(issuer, process.env.ENTRA_CLIENT_ID, process.env.ENTRA_CLIENT_SECRET);
  }
  return configPromise;
}

// state → { codeVerifier, nonce, createdAt } mezi /sso/start a /sso/callback.
// V paměti stačí — jednoprocesová appka, položky žijí jen pár desítek sekund.
const pending = new Map();

function cleanupPending() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [state, entry] of pending) {
    if (entry.createdAt < cutoff) pending.delete(state);
  }
}

export async function buildAuthorizationUrl(redirectUri) {
  const config = await getConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  cleanupPending();
  pending.set(state, { codeVerifier, nonce, createdAt: Date.now() });

  return client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
}

// currentUrl musí mít stejný origin+path jako redirectUri poslaný do
// buildAuthorizationUrl (openid-client si redirect_uri pro token endpoint
// odvozuje právě z currentUrl bez query stringu) — proto ho volající (auth.js)
// sestavuje z ENTRA_REDIRECT_URI + query z příchozího requestu, ne z req.protocol/host.
export async function handleCallback(currentUrl) {
  const config = await getConfig();
  const state = currentUrl.searchParams.get('state');
  const entry = state && pending.get(state);
  if (!entry) throw new Error('Neplatný nebo vypršelý přihlašovací požadavek');
  pending.delete(state);

  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: entry.codeVerifier,
    expectedNonce: entry.nonce,
    expectedState: state,
  });
  return tokens.claims();
}
