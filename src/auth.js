// Autentizace a role. Lokální účty + session cookie (HttpOnly).
// Při přechodu na SSO (Entra ID) se vymění jen login endpoint — guard,
// requireRole i tabulka users zůstávají.

import crypto from 'node:crypto';
import { isSsoEnabled, roleFromClaims, buildAuthorizationUrl, handleCallback } from './sso.js';

const COOKIE = 'isms_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hodin

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test);
}

const parseCookies = (header = '') =>
  Object.fromEntries(
    header.split(';').map((part) => {
      const i = part.indexOf('=');
      return i === -1 ? [part.trim(), ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
    }),
  );

const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, title: u.title, role: u.role });

export function createAuth(db) {
  // COOKIE_SECURE=1 v produkci (portál běží pod HTTPS) — na http://localhost by
  // prohlížeč cookie se secure:true vůbec neuložil. Čte se až tady (ne na
  // top-level modulu), protože ES module importy se vyhodnocují dřív než
  // server.js stihne zavolat loadEnv() — top-level čtení by vždy vidělo undefined.
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1' };

  function createSession(userId) {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
    return token;
  }

  function userForToken(token) {
    if (!token) return null;
    const row = db.prepare(
      'SELECT s.expires_at, u.id, u.username, u.name, u.title, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1',
    ).get(token);
    if (!row) return null;
    if (row.expires_at < new Date().toISOString()) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    return publicUser(row);
  }

  function registerAuthRoutes(app) {
    app.post('/api/auth/login', (req, res) => {
      const { username, password } = req.body ?? {};
      if (!username || !password) {
        return res.status(400).json({ error: 'Zadejte uživatelské jméno a heslo' });
      }
      const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username).trim().toLowerCase());
      if (!user || !verifyPassword(String(password), user.password_hash)) {
        return res.status(401).json({ error: 'Neplatné uživatelské jméno nebo heslo' });
      }
      const token = createSession(user.id);
      res.cookie(COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
      res.json(publicUser(user));
    });

    app.post('/api/auth/logout', (req, res) => {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      res.clearCookie(COOKIE, cookieOptions);
      res.status(204).end();
    });

    app.get('/api/auth/me', (req, res) => {
      const user = userForToken(parseCookies(req.headers.cookie)[COOKIE]);
      if (!user) return res.status(401).json({ error: 'Nepřihlášen' });
      res.json(user);
    });

    app.get('/api/auth/config', (req, res) => {
      res.json({ ssoEnabled: isSsoEnabled() });
    });
  }

  // Najde/vytvoří lokální účet podle Entra object id (JIT provisioning) a
  // u SSO účtů drží jméno/e-mail/roli synchronizované s Entra ID při každém
  // přihlášení. password_hash dostane náhodnou nepoužitelnou hodnotu, aby
  // NOT NULL constraint nevyžadoval schema změnu — účet se tak přes lokální
  // /api/auth/login přihlásit nikdy nemůže.
  function upsertSsoUser({ oid, name, email, role }) {
    const existing = db.prepare('SELECT * FROM users WHERE entra_oid = ?').get(oid);
    if (existing) {
      if (!existing.active) return null;
      db.prepare('UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?').run(name, email, role, existing.id);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
    }
    const username = `entra:${oid}`;
    const info = db.prepare(
      'INSERT INTO users (username, name, email, role, password_hash, entra_oid) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(username, name, email, role, hashPassword(crypto.randomBytes(32).toString('hex')), oid);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }

  function registerSsoRoutes(app) {
    app.get('/api/auth/sso/start', async (req, res) => {
      if (!isSsoEnabled()) return res.status(404).json({ error: 'SSO není nakonfigurováno' });
      try {
        const url = await buildAuthorizationUrl(process.env.ENTRA_REDIRECT_URI);
        res.redirect(url.href);
      } catch (err) {
        console.error(err);
        res.redirect(`${process.env.FRONTEND_URL}/?ssoError=start-failed`);
      }
    });

    app.get('/api/auth/sso/callback', async (req, res) => {
      if (!isSsoEnabled()) return res.status(404).json({ error: 'SSO není nakonfigurováno' });
      const frontend = process.env.FRONTEND_URL;
      try {
        // redirect_uri se pro token endpoint odvozuje od currentUrl bez query
        // stringu (viz sso.js) — proto se skládá z ENTRA_REDIRECT_URI, ne z
        // req.protocol/host, aby vždy přesně odpovídal tomu, co dostal /sso/start.
        const currentUrl = new URL(process.env.ENTRA_REDIRECT_URI);
        currentUrl.search = new URL(req.url, 'http://placeholder').search;

        const claims = await handleCallback(currentUrl);
        const role = roleFromClaims(claims);
        if (!role) return res.redirect(`${frontend}/?ssoError=no-role`);

        const user = upsertSsoUser({
          oid: claims.oid ?? claims.sub,
          name: claims.name ?? claims.preferred_username ?? claims.email,
          email: claims.email ?? claims.preferred_username ?? null,
          role,
        });
        if (!user) return res.redirect(`${frontend}/?ssoError=inactive`);

        const token = createSession(user.id);
        res.cookie(COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
        res.redirect(frontend);
      } catch (err) {
        console.error(err);
        res.redirect(`${frontend}/?ssoError=callback-failed`);
      }
    });
  }

  // Vše za tímto middlewarem vyžaduje přihlášení; uživatele přikládá do req.user
  function guard(req, res, next) {
    const user = userForToken(parseCookies(req.headers.cookie)[COOKIE]);
    if (!user) return res.status(401).json({ error: 'Nepřihlášen' });
    req.user = user;
    next();
  }

  const requireRole = (...roles) => (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Nedostatečná oprávnění pro tuto akci' });
    }
    next();
  };

  return { registerAuthRoutes, registerSsoRoutes, guard, requireRole };
}
