// Rate limiting na přihlašovací pokusy — v paměti, žádná závislost (stejný
// styl jako zbytek appky: hand-rolled env loader, hand-rolled scrypt hashing).
// Počítají se jen NEÚSPĚŠNÉ pokusy, ne každý request — legitimní uživatel,
// který se jednou překlepne, tím není blokován od dalšího přihlášení.
//
// Dvě vrstvy klíčů:
//  - IP+username: přísný limit na konkrétní účet (cílený brute force)
//  - IP samotné: volnější limit napříč účty ze stejné adresy (spray útok)
// Úspěšné přihlášení vyčistí počítadlo daného IP+username (ne to celoIPčkové).

const ACCOUNT_WINDOW_MS = Number(process.env.LOGIN_RATE_ACCOUNT_WINDOW_MS ?? 15 * 60 * 1000);
const ACCOUNT_MAX = Number(process.env.LOGIN_RATE_ACCOUNT_MAX ?? 5);
const IP_WINDOW_MS = Number(process.env.LOGIN_RATE_IP_WINDOW_MS ?? 15 * 60 * 1000);
const IP_MAX = Number(process.env.LOGIN_RATE_IP_MAX ?? 20);

function makeBucket() {
  const attempts = new Map(); // key -> { count, resetAt }

  function cleanup(now) {
    for (const [key, v] of attempts) {
      if (v.resetAt <= now) attempts.delete(key);
    }
  }

  return {
    isBlocked(key, max) {
      const now = Date.now();
      cleanup(now);
      const entry = attempts.get(key);
      return Boolean(entry && entry.count >= max && entry.resetAt > now);
    },
    registerFailure(key, windowMs) {
      const now = Date.now();
      const entry = attempts.get(key);
      if (!entry || entry.resetAt <= now) {
        attempts.set(key, { count: 1, resetAt: now + windowMs });
      } else {
        entry.count += 1;
      }
    },
    clear(key) {
      attempts.delete(key);
    },
    retryAfterSeconds(key) {
      const entry = attempts.get(key);
      if (!entry) return 0;
      return Math.max(0, Math.ceil((entry.resetAt - Date.now()) / 1000));
    },
  };
}

const byAccount = makeBucket();
const byIp = makeBucket();

export function loginRateLimited(ip, username) {
  const accountKey = `${ip}:${username}`;
  if (byIp.isBlocked(ip, IP_MAX)) return byIp.retryAfterSeconds(ip);
  if (byAccount.isBlocked(accountKey, ACCOUNT_MAX)) return byAccount.retryAfterSeconds(accountKey);
  return 0;
}

export function registerLoginFailure(ip, username) {
  byIp.registerFailure(ip, IP_WINDOW_MS);
  byAccount.registerFailure(`${ip}:${username}`, ACCOUNT_WINDOW_MS);
}

export function registerLoginSuccess(ip, username) {
  byAccount.clear(`${ip}:${username}`);
}
