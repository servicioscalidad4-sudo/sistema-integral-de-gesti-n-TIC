// Contraseñas (scrypt) y tokens firmados (HMAC-SHA256). Sin dependencias externas.
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'jr-secreto-de-desarrollo-CAMBIAR-en-Vercel';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const calc = crypto.scryptSync(String(pw), salt, 32);
  const hb = Buffer.from(h, 'hex');
  return hb.length === calc.length && crypto.timingSafeEqual(hb, calc);
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
  } catch (e) {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
