// Cliente mínimo de Supabase (PostgREST) usando fetch. Sin dependencias.
const { HttpError } = require('./util');

const baseUrl = () => (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const apiKey = () => (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

function mapError(status, d) {
  const code = d && d.code;
  const msg = (d && (d.message || d.error || d.hint)) || `Error ${status}`;
  if (code === '23505') return new HttpError(409, 'Ya existe un registro con esos datos (duplicado)');
  if (code === '23503') return new HttpError(400, 'Referencia inválida: ' + ((d && d.details) || msg));
  if (code === '23502') return new HttpError(400, 'Falta un dato obligatorio: ' + ((d && d.details) || msg));
  if (code === '23514') return new HttpError(400, 'Valor no permitido por la base de datos: ' + ((d && d.details) || msg));
  if (code === '22P02' || code === '22007' || code === '22008') return new HttpError(400, 'Dato con formato inválido');
  if (status === 401 || status === 403) return new HttpError(500, 'Supabase rechazó la clave del servidor. Revise SUPABASE_SERVICE_KEY en Vercel.');
  return new HttpError(500, 'Error de base de datos: ' + String(msg).slice(0, 300));
}

// params: objeto {col: 'eq.5'} o lista de pares [['col','eq.5'], ...]
async function rest(method, table, opts = {}) {
  const url = baseUrl(), key = apiKey();
  if (!url || !key) throw new HttpError(503, 'Falta configurar SUPABASE_URL y SUPABASE_SERVICE_KEY en las variables de entorno de Vercel');
  const sp = new URLSearchParams();
  const add = (k, v) => { if (v !== undefined && v !== null) sp.append(k, String(v)); };
  if (Array.isArray(opts.params)) opts.params.forEach(([k, v]) => add(k, v));
  else if (opts.params) Object.entries(opts.params).forEach(([k, v]) => add(k, v));
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  const pf = [];
  if (opts.prefer) pf.push(opts.prefer);
  if (opts.count) pf.push('count=exact');
  if (pf.length) headers.Prefer = pf.join(',');
  const qs = sp.toString();
  let res;
  try {
    res = await fetch(`${url}/rest/v1/${table}${qs ? '?' + qs : ''}`, {
      method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    throw new HttpError(502, 'No se pudo conectar con Supabase: ' + e.message);
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  if (!res.ok) throw mapError(res.status, data);
  let count = null;
  const cr = res.headers.get('content-range');
  if (cr && cr.includes('/')) { const n = cr.split('/')[1]; if (n !== '*') count = parseInt(n, 10); }
  return { data, count };
}

const select = async (table, params, opts = {}) => (await rest('GET', table, { params, ...opts })).data || [];
const insert = async (table, rows, ret = true) =>
  (await rest('POST', table, { body: rows, prefer: ret ? 'return=representation' : 'return=minimal' })).data;
const update = async (table, params, body, ret = false) =>
  (await rest('PATCH', table, { params, body, prefer: ret ? 'return=representation' : 'return=minimal' })).data;
const remove = async (table, params) => rest('DELETE', table, { params, prefer: 'return=minimal' });

// Trae todas las filas paginando de 1000 en 1000 (límite de PostgREST).
async function fetchAll(table, params = [], pageSize = 1000) {
  const base = Array.isArray(params) ? params : Object.entries(params);
  const out = [];
  for (let off = 0; off < 100000; off += pageSize) {
    const rows = await select(table, [...base, ['limit', pageSize], ['offset', off]]);
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

const inList = (ids) => `in.(${ids.join(',')})`;
async function byIds(table, ids, cols = '*', idCol = 'id') {
  const uniq = [...new Set(ids.filter((x) => x !== null && x !== undefined && x !== ''))];
  const out = [];
  for (let i = 0; i < uniq.length; i += 80) {
    out.push(...(await select(table, { select: cols, [idCol]: inList(uniq.slice(i, i + 80)) })));
  }
  return out;
}

module.exports = { rest, select, insert, update, remove, fetchAll, byIds, inList };
