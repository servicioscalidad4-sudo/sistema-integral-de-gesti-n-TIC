// Utilidades comunes: fechas (hora de Colombia), escape HTML, CSV
const pad = (n, l = 2) => String(n).padStart(l, '0');

// Hora de Colombia (UTC-5) sin sufijo Z: "2026-11-23T11:49:00"
const nowCO = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 19);
const todayCO = () => nowCO().slice(0, 10);

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ESC[ch]);
const unesc = (s) =>
  String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Escapa recursivamente todos los textos recibidos del cliente (anti-XSS),
// porque el frontend los inserta con innerHTML.
function sanitize(v, key) {
  if (typeof v === 'string') {
    if (key === 'password') return v;
    return key === 'email' ? v.trim() : esc(v.trim());
  }
  if (Array.isArray(v)) return v.map((x) => sanitize(x));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = sanitize(v[k], k);
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

module.exports = { pad, nowCO, todayCO, addDays, esc, unesc, sanitize, toCSV, norm };
