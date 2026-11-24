// Almacén de datos. Memoria + persistencia opcional en Upstash Redis / Vercel KV (REST).
const { buildSeed } = require('./seed');

const KEY = 'jr_sistema_db_v1';
let mem = null;
let lastLoad = 0;

function cfg() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}
async function cmd(c, args) {
  const r = await fetch(c.url, {
    method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error('KV HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

async function getDb(fresh) {
  const c = cfg();
  if (!c) { if (!mem) mem = buildSeed(); return mem; }
  if (mem && !fresh && Date.now() - lastLoad < 4000) return mem; // caché corta para lecturas
  try {
    const raw = await cmd(c, ['GET', KEY]);
    if (raw) mem = JSON.parse(raw);
    else { mem = buildSeed(); await cmd(c, ['SET', KEY, JSON.stringify(mem)]); }
    lastLoad = Date.now();
  } catch (e) {
    console.error('KV load error:', e.message);
    if (!mem) mem = buildSeed();
  }
  return mem;
}

async function saveDb() {
  const c = cfg();
  if (!c || !mem) return;
  try { await cmd(c, ['SET', KEY, JSON.stringify(mem)]); lastLoad = Date.now(); }
  catch (e) { console.error('KV save error:', e.message); }
}

const persistence = () => (cfg() ? 'redis' : 'memoria');
module.exports = { getDb, saveDb, persistence };
