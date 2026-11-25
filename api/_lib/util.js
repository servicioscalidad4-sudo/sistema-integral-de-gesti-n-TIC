// Utilidades comunes: errores HTTP, fechas (hora de Colombia), saneamiento, CSV
class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const pad = (n, l = 2) => String(n).padStart(l, '0');
const nowISO = () => new Date().toISOString();                       // para columnas timestamptz
const nowCO = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 19); // hora Colombia
const todayCO = () => nowCO().slice(0, 10);

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Convierte un timestamptz (UTC) a "YYYY-MM-DDTHH:MM:SS" en hora de Colombia.
// El frontend muestra substring(11,16) como hora, por eso se entrega ya convertido.
function co(ts) {
  if (!ts || typeof ts !== 'string' || ts.length <= 10) return ts;
  const d = new Date(ts);
  return isNaN(d) ? ts : new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 19);
}

// El frontend inserta textos con innerHTML: se neutralizan < > " (entrada y salida).
const ESC = { '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[<>"]/g, (ch) => ESC[ch]);
const unesc = (s) =>
  String(s == null ? '' : s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

function sanitize(v, key) {
  if (typeof v === 'string') return key === 'password' || key === 'email' ? v.trim() : esc(v.trim());
  if (Array.isArray(v)) return v.map((x) => sanitize(x));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = sanitize(v[k], k);
    return o;
  }
  return v;
}

const RAW_KEYS = new Set(['url_o_base64', 'evidencia_url', 'adjunto_url', 'evidencia_correccion', 'foto_url', 'error', 'message']);
function cleanOut(v, key) {
  if (typeof v === 'string') return RAW_KEYS.has(key) ? v : esc(v);
  if (Array.isArray(v)) return v.map((x) => cleanOut(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = cleanOut(v[k], k);
    return o;
  }
  return v;
}

function toCSV(headers, rows) {
  const q = (x) => {
    const s = unesc(x);
    return /[",;\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '\uFEFF' + [headers, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
}

const norm = (s) =>
  String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

module.exports = { HttpError, pad, nowISO, nowCO, todayCO, addDays, co, esc, unesc, sanitize, cleanOut, toCSV, norm };
