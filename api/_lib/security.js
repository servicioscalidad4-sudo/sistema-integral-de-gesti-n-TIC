// Contraseñas (bcrypt, compatible con crypt() de Postgres) y tokens firmados (HMAC-SHA256).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SECRET = process.env.JWT_SECRET || 'jr-secreto-de-desarrollo-CAMBIAR-en-Vercel';

const hashPassword = (pw) => bcrypt.hashSync(String(pw), 10);

function verifyPassword(pw, stored) {
  if (!stored) return false;
  pw = String(pw);
  try {
    if (/^\$2[abxy]\$/.test(stored)) return bcrypt.compareSync(pw, stored);           // bcrypt
    if (/^[a-f0-9]{64}$/i.test(stored)) {                                              // sha256 hex
      const h = crypto.createHash('sha256').update(pw).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(stored.toLowerCase()));
    }
    if (stored.includes(':')) {                                                        // scrypt salt:hash
      const [salt, h] = stored.split(':');
      const calc = crypto.scryptSync(pw, salt, 32), hb = Buffer.from(h, 'hex');
      return hb.length === calc.length && crypto.timingSafeEqual(hb, calc);
    }
  } catch (e) { /* formato no reconocido */ }
  return false;
}

function signToken(payload, ttlSeconds = 12 * 3600) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  try {
    if (!token) return null;
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(exp);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp && p.exp > Date.now() / 1000 ? p : null;
  } catch (e) { return null; }
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
