// ============================================================================
// JARDINES DEL RENACER - API sobre Supabase (Vercel Serverless Function)
// Todas las rutas /api/* se reescriben a esta función (ver vercel.json).
// ============================================================================
const crypto = require('crypto');
const D = require('./_lib/db');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./_lib/security');
const { HttpError, nowISO, todayCO, addDays, co, pad, sanitize, cleanOut, toCSV, unesc, norm } = require('./_lib/util');

const bad = (m) => new HttpError(400, m);
const forbid = (m) => new HttpError(403, m || 'No tiene permisos para esta acción');
const notFound = (m) => new HttpError(404, m || 'Registro no encontrado');
const EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'jardinesdelrenacer.com').toLowerCase();
const ASSET_COLS = 'id,id_origen,codigo_inventario,nombre,descripcion,categoria_id,tipo_elemento,marca,modelo,numero_serie,regional_id,sede_id,dependencia_id,ubicacion_especifica,responsable_id,estado_fisico,estado_operativo,estado_registro,created_at,updated_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const str = (v, max = 500) => (v == null ? '' : String(v).slice(0, max));
const blank = (v) => v == null || String(v).trim() === '';
const isRetirado = (k) => /retirad/i.test((k && k.estado_vinculacion) || '');
const isActivoColab = (k) => /^activ/i.test((k && k.estado_vinculacion) || '');
// Quita caracteres con significado especial en filtros PostgREST
const safeTxt = (s) => String(s || '').replace(/[,()*%\\"']/g, ' ').trim().slice(0, 80);

// ---------- rate limit en memoria ----------
const hits = new Map();
function limit(key, max, ms) {
  const n = Date.now(); const h = hits.get(key);
  if (!h || h.reset < n) { hits.set(key, { n: 1, reset: n + ms }); return; }
  if (++h.n > max) throw new HttpError(429, 'Demasiados intentos. Espere unos minutos e intente de nuevo.');
}

// ---------- caché corta en memoria ----------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const c = cache.get(key);
  if (c && c.t > Date.now()) return c.v;
  const v = await fn();
  cache.set(key, { t: Date.now() + ttlMs, v });
  return v;
}
const dropCache = (...prefixes) => { for (const k of [...cache.keys()]) if (prefixes.some((p) => k.startsWith(p))) cache.delete(k); };

// ---------- catálogos ----------
const canonRole = (n) => {
  const s = norm(n || '');
  if (s.includes('admin')) return 'ADMINISTRADOR';
  if (s.includes('coord')) return 'COORDINADOR';
  if (s.includes('calidad') || s.includes('audit')) return 'CALIDAD / AUDITOR';
  return String(n || '').toUpperCase();
};
const lookups = () => cached('lookups', 60000, async () => {
  const [regionales, sedes, categorias, roles] = await Promise.all([
    D.fetchAll('regionales', [['select', 'id,nombre,codigo,activa'], ['order', 'nombre.asc']]),
    D.fetchAll('sedes', [['select', 'id,regional_id,nombre,ciudad,activa'], ['order', 'nombre.asc']]),
    D.fetchAll('categorias_activos', [['select', 'id,nombre,codigo'], ['order', 'nombre.asc']]),
    D.fetchAll('roles', [['select', 'id,nombre']])
  ]);
  const m = (a) => new Map(a.map((x) => [x.id, x]));
  return { regionales, sedes, categorias, roles, R: m(regionales), S: m(sedes), C: m(categorias), ROL: m(roles) };
});

// ---------- usuarios / contexto ----------
async function loadUser(uid) {
  return cached('user:' + uid, 20000, async () => {
    const rows = await D.select('usuarios', { select: 'id,email,nombre_completo,cargo,rol_id,activo', id: 'eq.' + uid, limit: 1 });
    const u = rows[0];
    if (!u || u.activo === false) return null;
    const L = await lookups();
    const rol = L.ROL.get(u.rol_id);
    const regs = await D.select('usuario_regional', { select: 'regional_id', usuario_id: 'eq.' + uid });
    return { ...u, rol_nombre: canonRole(rol && rol.nombre), regionales: regs.map((r) => r.regional_id) };
  });
}
const userView = (u) => ({ id: u.id, nombre_completo: u.nombre_completo, email: u.email, cargo: u.cargo, rol_id: u.rol_id, rol_nombre: u.rol_nombre, regionales: u.regionales || [] });

const inScope = (c, rid) => c.scope == null || (rid != null && c.scope.includes(rid));
const assertScope = (c, rid) => { if (!inScope(c, rid)) throw forbid('El recurso pertenece a una regional que no tiene asignada'); };
// Filtro PostgREST para limitar por regional a los coordinadores
const scopePair = (c, col = 'regional_id') => (c.scope == null ? [] : [[col, `in.(${c.scope.length ? c.scope.join(',') : '-1'})`]]);

// Índice liviano de todos los activos (para KPIs y conteos), cacheado 20 s
const assetIndex = () => cached('assetIndex', 20000, () =>
  D.fetchAll('activos_maestros', [['select', 'id,regional_id,sede_id,categoria_id,responsable_id,codigo_inventario,numero_serie,estado_registro'], ['order', 'id.asc']]));
const colabsAll = () => cached('colabs', 20000, () =>
  D.fetchAll('colaboradores', [['select', 'id,documento,nombre_completo,cargo,regional_id,sede_id,estado_vinculacion,fecha_ingreso,fecha_retiro'], ['order', 'nombre_completo.asc']]));

const incompleto = (a) => blank(a.codigo_inventario) || blank(a.numero_serie) || !a.regional_id;

async function enrichActivos(rows) {
  const L = await lookups();
  const colabs = await D.byIds('colaboradores', rows.map((a) => a.responsable_id), 'id,nombre_completo,estado_vinculacion');
  const CM = new Map(colabs.map((k) => [k.id, k]));
  return rows.map((a) => {
    const res = CM.get(a.responsable_id), cat = L.C.get(a.categoria_id), reg = L.R.get(a.regional_id), sed = L.S.get(a.sede_id);
    return {
      id: a.id, id_origen: a.id_origen, codigo_inventario: a.codigo_inventario || null, numero_serie: a.numero_serie || null,
      nombre: a.nombre, marca: a.marca || '', modelo: a.modelo || '', descripcion: a.descripcion || '',
      categoria_id: a.categoria_id, categoria_nombre: cat ? cat.nombre : null, tipo_elemento: a.tipo_elemento || (cat ? cat.nombre : ''),
      regional_id: a.regional_id, regional_nombre: reg ? reg.nombre : null, sede_id: a.sede_id, sede_nombre: sed ? sed.nombre : null,
      ubicacion_especifica: a.ubicacion_especifica || '', responsable_id: a.responsable_id,
      responsable_nombre: res ? res.nombre_completo : null, responsable_estado: res ? res.estado_vinculacion : null,
      estado_fisico: a.estado_fisico, estado_operativo: a.estado_operativo, estado_registro: a.estado_registro,
      es_incompleto: incompleto(a)
    };
  });
}
async function getActivo(id) {
  if (!UUID.test(String(id))) return null;
  const r = await D.select('activos_maestros', { select: ASSET_COLS, id: 'eq.' + id, limit: 1 });
  return r[0] || null;
}
const flagsOf = (a) => ({ es_incompleto: incompleto(a), sin_serial: blank(a.numero_serie), sin_codigo: blank(a.codigo_inventario), sin_regional: !a.regional_id });

// ---------- efectos secundarios tolerantes a fallos ----------
async function logError(nivel, modulo, mensaje, detalle, userId, endpoint, ip) {
  try {
    await D.insert('logs_errores', { nivel, modulo, endpoint: endpoint || null, mensaje: String(mensaje).slice(0, 500), detalle_tecnico: String(detalle || '').slice(0, 3000), usuario_id: userId || null, ip: ip || null, resuelto: false }, false);
  } catch (e) { console.error('No se pudo registrar el log:', e.message); }
}
async function safe(c, etiqueta, fn) {
  try { return await fn(); }
  catch (e) {
    console.error(etiqueta, e.message);
    await logError('WARN', 'BACKEND', `${etiqueta}: ${e.message}`, e.stack, c.user && c.user.id, c.path, c.ip);
    (c.advertencias = c.advertencias || []).push(etiqueta);
    return null;
  }
}
// Notifica a usuarios por rol / regional
async function notify(c, { titulo, mensaje, tipo = 'INFO', roles = null, regional_id = null }) {
  return safe(c, 'notificación', async () => {
    const users = await cached('allusers', 60000, async () => {
      const [us, ur, L] = await Promise.all([
        D.fetchAll('usuarios', [['select', 'id,rol_id,activo']]), D.fetchAll('usuario_regional', [['select', 'usuario_id,regional_id']]), lookups()
      ]);
      return us.filter((u) => u.activo !== false).map((u) => ({ id: u.id, rol: canonRole((L.ROL.get(u.rol_id) || {}).nombre), regs: ur.filter((x) => x.usuario_id === u.id).map((x) => x.regional_id) }));
    });
    const targets = users.filter((u) => (!roles || roles.includes(u.rol)) && (regional_id == null || u.rol !== 'COORDINADOR' || u.regs.includes(regional_id)));
    if (!targets.length) return;
    await D.insert('notificaciones', targets.map((u) => ({ usuario_id: u.id, titulo, mensaje, tipo, leida: false })), false);
  });
}
const hist = (c, tabla, registro, accion, antes, despues) =>
  safe(c, 'historial', () => D.insert('historial_cambios', { tabla, registro_id: String(registro), accion, usuario_id: c.user ? c.user.id : null, datos_anteriores: antes || null, datos_nuevos: despues || null }, false));

// ---------- router ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, rx, keys, handler, opts });
}

// ============================================================================
// SALUD / DIAGNÓSTICO
// ============================================================================
route('GET', '/api/health', async () => {
  const out = {
    ok: true, servicio: 'Jardines del Renacer API', hora: new Date().toISOString(),
    supabase_url: !!process.env.SUPABASE_URL, supabase_key: !!(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY),
    jwt_secret: !!process.env.JWT_SECRET
  };
  try { const r = await D.rest('GET', 'activos_maestros', { params: { select: 'id', limit: 1 }, count: true }); out.base_de_datos = 'conectada'; out.total_activos = r.count; }
  catch (e) { out.ok = false; out.base_de_datos = 'error'; out.detalle = e.message; }
  return out;
}, { public: true });

// ============================================================================
// AUTENTICACIÓN
// ============================================================================
route('POST', '/api/auth/login', async (c) => {
  limit('login:' + c.ip, 20, 5 * 60 * 1000);
  const id = String(c.body.email || '').trim().toLowerCase(), pw = String(c.body.password || '');
  if (!id || !pw) throw bad('Ingrese usuario y contraseña');
  const pattern = (id.includes('@') ? id : id + '@%').replace(/[,()*\\"]/g, '');
  const rows = await D.select('usuarios', { select: 'id,email,password_hash,activo', email: 'ilike.' + pattern, limit: 5 });
  const u = rows.find((x) => x.activo !== false && (x.email.toLowerCase() === id || x.email.toLowerCase().split('@')[0] === id));
  if (!u || !verifyPassword(pw, u.password_hash)) throw bad('Usuario o contraseña incorrectos');
  dropCache('user:' + u.id);
  const full = await loadUser(u.id);
  return { token: signToken({ uid: u.id }), user: userView(full) };
}, { public: true });

route('POST', '/api/auth/register', async (c) => {
  limit('register:' + c.ip, 10, 60 * 60 * 1000);
  const b = c.body;
  const email = String(b.email || '').trim().toLowerCase(), nombre = String(b.nombre_completo || '').trim(), password = String(b.password || '');
  if (!nombre || !email || !password) throw bad('Complete nombre, correo y contraseña');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Correo electrónico inválido');
  if (EMAIL_DOMAIN !== '*' && !email.endsWith('@' + EMAIL_DOMAIN)) throw bad(`Use su correo corporativo (@${EMAIL_DOMAIN})`);
  if (password.length < 6) throw bad('La contraseña debe tener al menos 6 caracteres');
  const dup = await D.select('usuarios', { select: 'id', email: 'ilike.' + email.replace(/[,()*\\"%_]/g, '_'), limit: 1 });
  if (dup.length) throw new HttpError(409, 'Ya existe un usuario con ese correo');
  const wanted = { 1: 'ADMINISTRADOR', 2: 'COORDINADOR', 3: 'CALIDAD / AUDITOR' }[toInt(b.rol_id) || 2];
  if (wanted === 'ADMINISTRADOR') throw forbid('El rol Administrador requiere aprobación: solicítelo a un administrador existente');
  if (!wanted) throw bad('Rol inválido');
  const L = await lookups();
  const rol = L.roles.find((r) => canonRole(r.nombre) === wanted);
  if (!rol) throw bad('El rol solicitado no existe en la base de datos');
  const regional = toInt(b.regional_id);
  if (wanted === 'COORDINADOR' && !L.R.get(regional)) throw bad('El coordinador debe tener una regional asignada');
  const id = crypto.randomUUID();
  await D.insert('usuarios', { id, email, password_hash: hashPassword(password), nombre_completo: nombre, cargo: str(b.cargo, 120), rol_id: rol.id, activo: true }, false);
  if (wanted === 'COORDINADOR') await D.insert('usuario_regional', { usuario_id: id, regional_id: regional }, false);
  dropCache('allusers');
  const full = await loadUser(id);
  c.user = full;
  await notify(c, { titulo: 'Nuevo usuario registrado', mensaje: `${nombre} (${wanted}) creó su cuenta.`, roles: ['ADMINISTRADOR'] });
  return { token: signToken({ uid: id }), user: userView(full) };
}, { public: true });

route('GET', '/api/auth/me', (c) => ({ user: userView(c.user) }));

// ============================================================================
// CATÁLOGOS
// ============================================================================
route('GET', '/api/regionales', async () => {
  const [L, idx] = await Promise.all([lookups(), assetIndex()]);
  return {
    regionales: L.regionales.filter((r) => r.activa !== false).map((r) => ({
      id: r.id, nombre: r.nombre, codigo: r.codigo,
      total_sedes: L.sedes.filter((s) => s.regional_id === r.id && s.activa !== false).length,
      total_activos: idx.filter((a) => a.regional_id === r.id).length
    }))
  };
});
route('GET', '/api/sedes', async () => ({ sedes: (await lookups()).sedes.filter((s) => s.activa !== false).map(({ id, regional_id, nombre, ciudad }) => ({ id, regional_id, nombre, ciudad })) }));
route('GET', '/api/categorias', async () => ({ categorias: (await lookups()).categorias.map(({ id, nombre, codigo }) => ({ id, nombre, codigo })) }));

// ============================================================================
// DASHBOARD
// ============================================================================
route('GET', '/api/dashboard', async (c) => {
  const [L, idx, colabs] = await Promise.all([lookups(), assetIndex(), colabsAll()]);
  const act = c.scope == null ? idx : idx.filter((a) => a.regional_id && c.scope.includes(a.regional_id));
  const retirados = new Set(colabs.filter(isRetirado).map((k) => k.id));
  const cnt = async (table, extra) => (await D.rest('GET', table, { params: [['select', 'id'], ['limit', 1], ...extra], count: true })).count || 0;
  const [abiertos, totalAud, totalJor, auds, jors] = await Promise.all([
    cnt('hallazgos', [['estado', 'neq.CERRADO'], ...scopePair(c)]),
    cnt('auditorias', scopePair(c)),
    cnt('programaciones', scopePair(c)),
    D.select('auditorias', [['select', 'porcentaje_cumplimiento'], ['porcentaje_cumplimiento', 'not.is.null'], ...scopePair(c), ['limit', 1000]]),
    D.select('programaciones', [['select', 'id,fecha_inicio,fecha_fin,estado'], ...scopePair(c), ['limit', 1000]])
  ]);
  const hoy = todayCO();
  const enEj = jors.filter((j) => !/finaliz|cancel/i.test(j.estado || '') && hoy >= j.fecha_inicio && hoy <= j.fecha_fin).length;
  const prom = auds.length ? auds.reduce((s, a) => s + Number(a.porcentaje_cumplimiento || 0), 0) / auds.length : null;
  const regs = L.regionales.filter((r) => r.activa !== false && inScope(c, r.id));
  return {
    activos_kpis: {
      total_activos: act.length, incompletos: act.filter(incompleto).length,
      sin_serial: act.filter((a) => blank(a.numero_serie)).length, sin_codigo: act.filter((a) => blank(a.codigo_inventario)).length,
      sin_regional: act.filter((a) => !a.regional_id).length, nuevos: act.filter((a) => /^NUEVO/i.test(a.estado_registro || '')).length,
      activos_en_retirados: act.filter((a) => retirados.has(a.responsable_id)).length
    },
    calidad_kpis: { total_auditorias: totalAud, promedio_cumplimiento: prom },
    hallazgos_kpis: { abiertos },
    calendario_kpis: { total_jornadas: totalJor, en_ejecucion: enEj },
    por_regional: regs.map((r) => ({ id: r.id, nombre: r.nombre, cantidad: act.filter((a) => a.regional_id === r.id).length })).sort((a, b) => b.cantidad - a.cantidad),
    por_categoria: L.categorias.map((k) => ({ id: k.id, nombre: k.nombre, cantidad: act.filter((a) => a.categoria_id === k.id).length })).sort((a, b) => b.cantidad - a.cantidad)
  };
});

// ============================================================================
// INVENTARIO MAESTRO
// ============================================================================
const EMPTY = (col) => `${col}.is.null,${col}.eq.`;
route('GET', '/api/maestro', async (c) => {
  const q = c.q;
  const params = [['select', ASSET_COLS], ['order', 'nombre.asc'], ['order', 'id.asc'], ...scopePair(c)];
  const clauses = [];
  const txt = safeTxt(q.q);
  if (txt) {
    const cols = ['nombre', 'codigo_inventario', 'numero_serie', 'marca', 'modelo', 'ubicacion_especifica'].map((k) => `${k}.ilike.*${txt}*`);
    const ks = await D.select('colaboradores', { select: 'id', nombre_completo: `ilike.*${txt}*`, limit: 100 });
    if (ks.length) cols.push(`responsable_id.in.(${ks.map((k) => k.id).join(',')})`);
    clauses.push(`or(${cols.join(',')})`);
  }
  if (q.regional_id && toInt(q.regional_id)) params.push(['regional_id', 'eq.' + toInt(q.regional_id)]);
  if (q.sede_id && toInt(q.sede_id)) params.push(['sede_id', 'eq.' + toInt(q.sede_id)]);
  if (q.categoria_id && toInt(q.categoria_id)) params.push(['categoria_id', 'eq.' + toInt(q.categoria_id)]);
  if (q.estado_fisico) params.push(['estado_fisico', 'eq.' + safeTxt(q.estado_fisico)]);
  if (q.estado_operativo) params.push(['estado_operativo', 'eq.' + safeTxt(q.estado_operativo)]);
  if (q.estado_registro) params.push(['estado_registro', 'eq.' + safeTxt(q.estado_registro)]);
  switch (q.integridad) {
    case 'sin_serial': clauses.push(`or(${EMPTY('numero_serie')})`); break;
    case 'sin_codigo': clauses.push(`or(${EMPTY('codigo_inventario')})`); break;
    case 'sin_regional': params.push(['regional_id', 'is.null']); break;
    case 'incompletos': clauses.push(`or(${EMPTY('codigo_inventario')},${EMPTY('numero_serie')},regional_id.is.null)`); break;
    case 'completos': clauses.push('codigo_inventario.not.is.null', 'codigo_inventario.neq.', 'numero_serie.not.is.null', 'numero_serie.neq.', 'regional_id.not.is.null'); break;
    default: break;
  }
  if (clauses.length) params.push(['and', `(${clauses.join(',')})`]);
  const size = Math.min(100, Math.max(1, toInt(q.page_size) || 15));
  const pageReq = Math.max(1, toInt(q.page) || 1);
  params.push(['limit', size], ['offset', (pageReq - 1) * size]);
  const { data, count } = await D.rest('GET', 'activos_maestros', { params, count: true });
  const total = count == null ? (data || []).length : count;
  return { items: await enrichActivos(data || []), total, page: pageReq, page_size: size, total_pages: Math.max(1, Math.ceil(total / size)) };
});

route('GET', '/api/maestro/export', (c) => csvReport(c, 1));

route('GET', '/api/maestro/:id', async (c) => {
  const a = await getActivo(c.params.id);
  if (!a) throw notFound('Activo no encontrado');
  assertScope(c, a.regional_id);
  const [v] = await enrichActivos([a]);
  const [movs, fotos] = await Promise.all([
    D.select('movimientos', { select: '*', activo_id: 'eq.' + a.id, order: 'fecha.desc', limit: 100 }),
    D.select('fotografias_activos', { select: 'id,tipo_foto,url_o_base64,descripcion', activo_id: 'eq.' + a.id, order: 'id.desc', limit: 20 })
  ]);
  v.movimientos = await movViews(movs);
  v.fotografias = fotos;
  return { activo: v };
});

route('POST', '/api/activos/search-first', async (c) => {
  const t = safeTxt(c.body.q);
  if (!t) throw bad('Ingrese un término de búsqueda');
  const cols = ['codigo_inventario', 'numero_serie', 'nombre', 'marca', 'modelo'].map((k) => `${k}.ilike.*${t}*`).join(',');
  const rows = await D.select('activos_maestros', [['select', ASSET_COLS], ['or', `(${cols})`], ...scopePair(c), ['order', 'nombre.asc'], ['limit', 10]]);
  return { coincidencias: await enrichActivos(rows) };
});

// Registra una verificación física (inventarios_fisicos) ligada a la jornada activa, si existe
async function registrarInventarioFisico(c, a, extra = {}) {
  return safe(c, 'inventario físico', async () => {
    const hoy = todayCO();
    if (!a.regional_id) {
      await D.insert('inventarios_fisicos', { activo_id: a.id, fecha_verificacion: nowISO(), usuario_id: c.user.id, observaciones: extra.observaciones || null, coincide_maestro: false }, false);
      return;
    }
    const progs = await D.select('programaciones', { select: 'id,estado', regional_id: 'eq.' + a.regional_id, fecha_inicio: 'lte.' + hoy, fecha_fin: 'gte.' + hoy, order: 'id.desc', limit: 5 });
    const prog = progs.find((p) => !/finaliz|cancel/i.test(p.estado || ''));
    let progId = null;
    if (prog) {
      const ps = await D.select('programacion_sedes', { select: 'sede_id', programacion_id: 'eq.' + prog.id });
      if (!ps.length || ps.some((x) => x.sede_id === a.sede_id)) progId = prog.id;
    }
    await D.insert('inventarios_fisicos', {
      activo_id: a.id, programacion_id: progId, fecha_verificacion: nowISO(), usuario_id: c.user.id, regional_id: a.regional_id, sede_id: a.sede_id,
      ubicacion_especifica: a.ubicacion_especifica || null, responsable_id: a.responsable_id || null, estado_fisico: a.estado_fisico || null,
      estado_operativo: a.estado_operativo || null, coincide_maestro: extra.coincide !== false, observaciones: extra.observaciones || null
    }, false);
  });
}

route('POST', '/api/activos/create', async (c) => {
  const b = c.body;
  const nombre = str(b.nombre, 200).trim();
  if (!nombre) throw bad('El nombre del activo es obligatorio');
  const L = await lookups();
  const regional = toInt(b.regional_id), sede = toInt(b.sede_id), categoria = toInt(b.categoria_id);
  if (regional) { if (!L.R.get(regional)) throw bad('Regional inválida'); assertScope(c, regional); }
  else if (c.scope) throw bad('Debe seleccionar una regional');
  if (sede && (!L.S.get(sede) || L.S.get(sede).regional_id !== regional)) throw bad('La sede no pertenece a la regional seleccionada');
  const codigo = str(b.codigo_inventario, 80).trim() || null, serie = str(b.numero_serie, 120).trim() || null;
  for (const [col, val, label] of [['codigo_inventario', codigo, 'código de inventario'], ['numero_serie', serie, 'número de serie']]) {
    if (!val) continue;
    const d = await D.select('activos_maestros', { select: 'id', [col]: 'ilike.' + val.replace(/[,()*%_\\"]/g, '_'), limit: 5 });
    if (d.length) throw new HttpError(409, `Ya existe un activo con ese ${label}. Use la consulta previa para actualizarlo.`);
  }
  const a = {
    id: crypto.randomUUID(), id_origen: null, codigo_inventario: codigo, numero_serie: serie, nombre, descripcion: str(b.observaciones, 1000) || null,
    categoria_id: categoria, tipo_elemento: (L.C.get(categoria) || {}).nombre || null, marca: str(b.marca, 80), modelo: str(b.modelo, 80),
    regional_id: regional, sede_id: sede || null, dependencia_id: null, ubicacion_especifica: str(b.ubicacion_especifica, 200),
    responsable_id: null, estado_fisico: str(b.estado_fisico, 40) || 'BUENO', estado_operativo: 'OPERATIVO',
    estado_registro: 'NUEVO - PENDIENTE DE VALIDACIÓN', origen_csv: false
  };
  Object.assign(a, flagsOf(a));
  await D.insert('activos_maestros', a, false);
  dropCache('assetIndex');
  await safe(c, 'movimiento', () => D.insert('movimientos', { activo_id: a.id, tipo_movimiento: 'REGISTRO', regional_nueva_id: regional, sede_nueva_id: sede || null, ubicacion_nueva: a.ubicacion_especifica, motivo: str(b.observaciones, 500) || 'Registro de activo nuevo', usuario_id: c.user.id }, false));
  await registrarInventarioFisico(c, a, { coincide: false, observaciones: 'Activo nuevo registrado en campo' });
  await hist(c, 'activos_maestros', a.id, 'INSERT', null, { nombre, codigo_inventario: codigo, numero_serie: serie });
  await notify(c, { titulo: 'Nuevo activo pendiente de validación', mensaje: `${nombre} fue registrado por ${c.user.nombre_completo}.`, roles: ['ADMINISTRADOR', 'CALIDAD / AUDITOR'] });
  return { message: 'Activo registrado como NUEVO - PENDIENTE DE VALIDACIÓN', activo_id: a.id, advertencias: c.advertencias };
});

route('POST', '/api/activos/update-physical', async (c) => {
  const b = c.body, L = await lookups();
  const a = await getActivo(b.activo_id);
  if (!a) throw notFound('Activo no encontrado');
  assertScope(c, a.regional_id);
  const regional = toInt(b.regional_id) || a.regional_id;
  if (!L.R.get(regional)) throw bad('Regional inválida');
  assertScope(c, regional);
  let sede = toInt(b.sede_id);
  if (!sede && regional === a.regional_id) sede = a.sede_id;
  if (sede && (!L.S.get(sede) || L.S.get(sede).regional_id !== regional)) throw bad('La sede no pertenece a la regional seleccionada');
  const ubic = b.ubicacion_especifica != null ? str(b.ubicacion_especifica, 200) : a.ubicacion_especifica || '';
  const fis = b.estado_fisico ? str(b.estado_fisico, 40) : a.estado_fisico;
  const just = str(b.observaciones, 500) || 'Verificación física';
  const nr = (id) => (L.R.get(id) || {}).nombre || '', ns = (id) => (L.S.get(id) || {}).nombre || '';
  const cambios = [];
  if (regional !== a.regional_id) cambios.push(['regional', nr(a.regional_id), nr(regional)]);
  if ((sede || null) !== (a.sede_id || null)) cambios.push(['sede', ns(a.sede_id), ns(sede)]);
  if (ubic !== (a.ubicacion_especifica || '')) cambios.push(['ubicacion_especifica', a.ubicacion_especifica || '', ubic]);
  if (fis !== a.estado_fisico) cambios.push(['estado_fisico', a.estado_fisico || '', fis]);
  const nuevo = { ...a, regional_id: regional, sede_id: sede || null, ubicacion_especifica: ubic, estado_fisico: fis };
  await D.update('activos_maestros', { id: 'eq.' + a.id }, { regional_id: nuevo.regional_id, sede_id: nuevo.sede_id, ubicacion_especifica: ubic, estado_fisico: fis, ...flagsOf(nuevo), updated_at: nowISO() });
  dropCache('assetIndex');
  if (cambios.length) {
    await safe(c, 'novedades', () => D.insert('novedades', cambios.map(([campo, ant, nvo]) => ({ activo_id: a.id, tipo_novedad: 'ACTUALIZACION_FISICA', campo_modificado: campo, valor_anterior: ant, valor_nuevo: nvo, justificacion: just, usuario_id: c.user.id, estado: 'REGISTRADA' })), false));
  }
  const traslado = cambios.some(([k]) => k !== 'estado_fisico');
  await safe(c, 'movimiento', () => D.insert('movimientos', {
    activo_id: a.id, tipo_movimiento: traslado ? 'TRASLADO' : 'VERIFICACION FISICA', responsable_anterior_id: a.responsable_id, responsable_nuevo_id: a.responsable_id,
    regional_anterior_id: a.regional_id, regional_nueva_id: regional, sede_anterior_id: a.sede_id, sede_nueva_id: sede || null,
    ubicacion_anterior: a.ubicacion_especifica || null, ubicacion_nueva: ubic, motivo: just, usuario_id: c.user.id
  }, false));
  await registrarInventarioFisico(c, nuevo, { coincide: cambios.length === 0, observaciones: just });
  if (cambios.length) await hist(c, 'activos_maestros', a.id, 'UPDATE', { regional_id: a.regional_id, sede_id: a.sede_id, ubicacion_especifica: a.ubicacion_especifica, estado_fisico: a.estado_fisico }, { regional_id: regional, sede_id: sede || null, ubicacion_especifica: ubic, estado_fisico: fis });
  return { ok: true, cambios: cambios.length, message: 'Actualización registrada', advertencias: c.advertencias };
});

// ============================================================================
// COLABORADORES
// ============================================================================
const colabsScoped = async (c) => (await colabsAll()).filter((k) => c.scope == null || (k.regional_id && c.scope.includes(k.regional_id)));
async function colabViews(list) {
  const [L, idx] = await Promise.all([lookups(), assetIndex()]);
  const counts = new Map();
  idx.forEach((a) => { if (a.responsable_id) counts.set(a.responsable_id, (counts.get(a.responsable_id) || 0) + 1); });
  return list.map((k) => ({
    ...k, regional_nombre: (L.R.get(k.regional_id) || {}).nombre || null, sede_nombre: (L.S.get(k.sede_id) || {}).nombre || null, total_activos: counts.get(k.id) || 0
  }));
}

route('GET', '/api/colaboradores', async (c) => ({ colaboradores: await colabViews(await colabsScoped(c)) }));

route('GET', '/api/colaboradores/retirados-con-activos', async (c) => {
  const v = await colabViews((await colabsScoped(c)).filter(isRetirado));
  return { retirados: v.filter((k) => k.total_activos > 0).map((k) => ({ ...k, activos_pendientes: k.total_activos })) };
});

route('POST', '/api/colaboradores/reasignar-activos', async (c) => {
  const origen = toInt(c.body.colaborador_origen_id), destino = toInt(c.body.colaborador_destino_id);
  const k = (await colabsAll()).find((x) => x.id === origen);
  if (!k) throw notFound('Colaborador origen no encontrado');
  assertScope(c, k.regional_id);
  let d = null;
  if (destino) {
    d = (await colabsAll()).find((x) => x.id === destino);
    if (!d || !isActivoColab(d)) throw bad('El colaborador destino no existe o no está activo');
  }
  const lista = await D.fetchAll('activos_maestros', [['select', 'id,regional_id,sede_id,ubicacion_especifica'], ['responsable_id', 'eq.' + origen], ['order', 'id.asc']]);
  if (!lista.length) return { message: 'El colaborador no tiene activos asignados', reasignados: 0 };
  await D.update('activos_maestros', { responsable_id: 'eq.' + origen }, { responsable_id: d ? d.id : null, updated_at: nowISO() });
  dropCache('assetIndex');
  const motivo = d ? `Reasignación por retiro de ${k.nombre_completo}` : `Devolución a stock por retiro de ${k.nombre_completo}`;
  const hoy = todayCO();
  for (let i = 0; i < lista.length; i += 300) {
    const parte = lista.slice(i, i + 300);
    await safe(c, 'movimientos', () => D.insert('movimientos', parte.map((a) => ({ activo_id: a.id, tipo_movimiento: d ? 'REASIGNACION' : 'DEVOLUCION', responsable_anterior_id: origen, responsable_nuevo_id: d ? d.id : null, regional_anterior_id: a.regional_id, regional_nueva_id: a.regional_id, sede_anterior_id: a.sede_id, sede_nueva_id: a.sede_id, ubicacion_nueva: d ? null : 'Stock disponible', motivo, usuario_id: c.user.id })), false));
  }
  await safe(c, 'asignaciones', async () => {
    await D.update('asignaciones', { colaborador_id: 'eq.' + origen, fecha_devolucion: 'is.null' }, { fecha_devolucion: hoy, estado: 'DEVUELTA' });
    if (d) for (let i = 0; i < lista.length; i += 300) await D.insert('asignaciones', lista.slice(i, i + 300).map((a) => ({ activo_id: a.id, colaborador_id: d.id, fecha_asignacion: hoy, estado: 'ACTIVA', motivo, usuario_id: c.user.id })), false);
  });
  return { message: 'Activos reasignados', reasignados: lista.length, advertencias: c.advertencias };
});

route('POST', '/api/colaboradores', async (c) => {
  const b = c.body, L = await lookups();
  const doc = str(b.documento, 40).trim(), nombre = str(b.nombre_completo, 200).trim();
  if (!doc || !nombre) throw bad('Documento y nombre son obligatorios');
  if ((await colabsAll()).some((k) => k.documento === doc)) throw new HttpError(409, 'Ya existe un colaborador con ese documento');
  const regional = toInt(b.regional_id), sede = toInt(b.sede_id);
  if (regional) { if (!L.R.get(regional)) throw bad('Regional inválida'); assertScope(c, regional); }
  else if (c.scope) throw bad('Debe seleccionar una regional');
  if (sede && (!L.S.get(sede) || L.S.get(sede).regional_id !== regional)) throw bad('La sede no pertenece a la regional seleccionada');
  const rows = await D.insert('colaboradores', { documento: doc, nombre_completo: nombre, cargo: str(b.cargo, 120), regional_id: regional, sede_id: sede || null, fecha_ingreso: b.fecha_ingreso || todayCO(), estado_vinculacion: 'ACTIVO' });
  dropCache('colabs');
  return { ok: true, colaborador: (await colabViews(rows))[0] };
});

route('POST', '/api/colaboradores/:id', async (c) => {
  const id = toInt(c.params.id), b = c.body;
  const k = (await colabsAll()).find((x) => x.id === id);
  if (!k) throw notFound('Colaborador no encontrado');
  assertScope(c, k.regional_id);
  const patch = {};
  if (b.cargo != null) patch.cargo = str(b.cargo, 120);
  let retiroNuevo = false;
  if (b.estado_vinculacion) {
    if (!['ACTIVO', 'RETIRADO'].includes(b.estado_vinculacion)) throw bad('Estado de vinculación inválido');
    patch.estado_vinculacion = b.estado_vinculacion;
    patch.fecha_retiro = b.estado_vinculacion === 'RETIRADO' ? b.fecha_retiro || todayCO() : null;
    retiroNuevo = b.estado_vinculacion === 'RETIRADO' && !isRetirado(k);
  }
  if (!Object.keys(patch).length) throw bad('No hay cambios para guardar');
  await D.update('colaboradores', { id: 'eq.' + id }, patch);
  dropCache('colabs');
  if (retiroNuevo) {
    const n = (await assetIndex()).filter((a) => a.responsable_id === id).length;
    if (n > 0) await notify(c, { titulo: 'Colaborador retirado con activos pendientes', mensaje: `${k.nombre_completo} fue retirado y tiene ${n} activo(s) por devolver o reasignar.`, tipo: 'ALERTA', roles: ['ADMINISTRADOR', 'COORDINADOR'], regional_id: k.regional_id });
  }
  return { ok: true };
});

// ============================================================================
// CALENDARIO / JORNADAS (tabla programaciones)
// ============================================================================
function jornadaEstado(j, verificados, meta) {
  if (/finaliz/i.test(j.estado || '')) return 'FINALIZADO';
  if (/cancel/i.test(j.estado || '')) return 'CANCELADO';
  if (meta > 0 && verificados >= meta) return 'FINALIZADO';
  const t = todayCO();
  if (t > j.fecha_fin) return 'VENCIDO';
  if (t >= j.fecha_inicio) return 'EN EJECUCION';
  return 'PROGRAMADO';
}
async function jornadaViews(list) {
  if (!list.length) return [];
  const ids = list.map((j) => j.id);
  const [L, idx, ps, inv, us] = await Promise.all([
    lookups(), assetIndex(),
    D.byIds('programacion_sedes', ids, 'programacion_id,sede_id', 'programacion_id'),
    D.byIds('inventarios_fisicos', ids, 'programacion_id,activo_id', 'programacion_id'),
    D.byIds('usuarios', list.map((j) => j.coordinador_id), 'id,nombre_completo')
  ]);
  const UM = new Map(us.map((u) => [u.id, u]));
  return list.map((j) => {
    const sedeIds = ps.filter((x) => x.programacion_id === j.id).map((x) => x.sede_id);
    const verif = new Set(inv.filter((x) => x.programacion_id === j.id).map((x) => x.activo_id)).size;
    const total = idx.filter((a) => a.regional_id === j.regional_id && (!sedeIds.length || sedeIds.includes(a.sede_id))).length;
    const meta = j.meta_verificacion || j.cantidad_estimada || total;
    return {
      id: j.id, titulo: j.titulo, tipo_actividad: j.tipo_actividad, regional_id: j.regional_id, regional_nombre: (L.R.get(j.regional_id) || {}).nombre || '-',
      sedes: sedeIds.map((id) => L.S.get(id)).filter(Boolean).map((s) => ({ id: s.id, nombre: s.nombre })),
      fecha_inicio: j.fecha_inicio, fecha_fin: j.fecha_fin, hora_inicio: j.hora_inicio, hora_fin: j.hora_fin,
      coordinador_nombre: (UM.get(j.coordinador_id) || {}).nombre_completo || null, activos_verificados: verif, meta_verificacion: j.meta_verificacion,
      total_activos_sede: total, porcentaje_avance: meta ? Math.min(100, Math.round((verif / meta) * 100)) : 0, estado: jornadaEstado(j, verif, meta)
    };
  });
}

route('GET', '/api/calendario', async (c) => {
  const rows = await D.select('programaciones', [['select', '*'], ...scopePair(c), ['order', 'fecha_inicio.desc'], ['limit', 300]]);
  return { jornadas: await jornadaViews(rows) };
});

route('GET', '/api/calendario/control-nacional', async (c) => {
  const [L, rows] = await Promise.all([lookups(), D.select('programaciones', [['select', 'id,regional_id,fecha_inicio,fecha_fin,estado'], ...scopePair(c), ['limit', 1000]])]);
  const hoy = todayCO();
  return {
    control_nacional: L.regionales.filter((r) => r.activa !== false && inScope(c, r.id)).map((r) => {
      const js = rows.filter((j) => j.regional_id === r.id);
      return { id: r.id, nombre: r.nombre, total_jornadas: js.length, en_ejecucion: js.filter((j) => !/finaliz|cancel/i.test(j.estado || '') && hoy >= j.fecha_inicio && hoy <= j.fecha_fin).length };
    })
  };
});

route('POST', '/api/calendario', async (c) => {
  const b = c.body, L = await lookups();
  const regional = toInt(b.regional_id);
  if (!b.titulo) throw bad('El nombre de la actividad es obligatorio');
  if (!L.R.get(regional)) throw bad('Seleccione una regional válida');
  assertScope(c, regional);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_inicio || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_fin || '')) throw bad('Fechas inválidas');
  if (b.fecha_fin < b.fecha_inicio) throw bad('La fecha fin no puede ser anterior a la fecha de inicio');
  const sedes = (Array.isArray(b.sedes_ids) ? b.sedes_ids : []).map(toInt).filter((id) => L.S.get(id) && L.S.get(id).regional_id === regional);
  const rows = await D.insert('programaciones', {
    titulo: str(b.titulo, 200), tipo_actividad: str(b.tipo_actividad, 80) || 'Verificación física', regional_id: regional, fecha_inicio: b.fecha_inicio, fecha_fin: b.fecha_fin,
    hora_inicio: '08:00', hora_fin: '17:00', coordinador_id: c.user.id, meta_verificacion: Math.max(0, toInt(b.meta_verificacion) || 0),
    prioridad: 'MEDIA', estado: 'PROGRAMADO', created_by: c.user.id
  });
  const j = rows[0];
  if (sedes.length) await safe(c, 'sedes de la jornada', () => D.insert('programacion_sedes', sedes.map((s) => ({ programacion_id: j.id, sede_id: s })), false));
  if (b.crear_chat) await safe(c, 'chat de la jornada', () => D.insert('conversaciones', { titulo: `Jornada: ${j.titulo}`, tipo: 'JORNADA', regional_id: regional, programacion_id: j.id }, false));
  await notify(c, { titulo: 'Nueva jornada programada', mensaje: `${j.titulo} (${j.fecha_inicio} al ${j.fecha_fin}).`, regional_id: regional });
  return { ok: true, jornada: (await jornadaViews([j]))[0], advertencias: c.advertencias };
}, { roles: ['ADMINISTRADOR', 'COORDINADOR'] });

route('POST', '/api/calendario/:id/reprogramar', async (c) => {
  const id = toInt(c.params.id), b = c.body;
  const j = (await D.select('programaciones', { select: '*', id: 'eq.' + id, limit: 1 }))[0];
  if (!j) throw notFound('Jornada no encontrada');
  assertScope(c, j.regional_id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_inicio || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_fin || '')) throw bad('Fechas inválidas');
  if (b.fecha_fin < b.fecha_inicio) throw bad('La fecha fin no puede ser anterior a la fecha de inicio');
  if (!b.motivo) throw bad('El motivo de la reprogramación es obligatorio');
  const obs = `${j.observaciones ? j.observaciones + '\n' : ''}[${todayCO()}] Reprogramada: ${j.fecha_inicio} al ${j.fecha_fin} → ${b.fecha_inicio} al ${b.fecha_fin}. Motivo: ${str(b.motivo, 300)}`;
  await D.update('programaciones', { id: 'eq.' + id }, { fecha_inicio: b.fecha_inicio, fecha_fin: b.fecha_fin, estado: 'PROGRAMADO', observaciones: obs, updated_at: nowISO() });
  await hist(c, 'programaciones', id, 'REPROGRAMAR', { fecha_inicio: j.fecha_inicio, fecha_fin: j.fecha_fin }, { fecha_inicio: b.fecha_inicio, fecha_fin: b.fecha_fin, motivo: b.motivo });
  await notify(c, { titulo: 'Jornada reprogramada', mensaje: `${j.titulo}: ${b.fecha_inicio} al ${b.fecha_fin}. Motivo: ${b.motivo}`, regional_id: j.regional_id });
  return { ok: true };
}, { roles: ['ADMINISTRADOR', 'COORDINADOR'] });

// ============================================================================
// CHAT
// ============================================================================
async function convVisibles(c) {
  const convs = await D.select('conversaciones', [['select', 'id,titulo,tipo,regional_id,sede_id,programacion_id'], ['order', 'id.asc'], ['limit', 500]]);
  if (c.scope == null) return convs;
  const part = await D.select('participantes_conversacion', { select: 'conversacion_id', usuario_id: 'eq.' + c.user.id });
  const mine = new Set(part.map((p) => p.conversacion_id));
  return convs.filter((v) => v.regional_id == null || c.scope.includes(v.regional_id) || mine.has(v.id));
}

route('GET', '/api/chat/conversaciones', async (c) => {
  const convs = await convVisibles(c);
  const msgs = convs.length ? await D.select('mensajes', [['select', 'conversacion_id,texto,created_at'], ['conversacion_id', `in.(${convs.map((v) => v.id).join(',')})`], ['order', 'created_at.desc'], ['limit', 400]]) : [];
  return { conversaciones: convs.map((v) => { const m = msgs.find((x) => x.conversacion_id === v.id); return { id: v.id, titulo: v.titulo, tipo: v.tipo, regional_id: v.regional_id, ultimo_mensaje: m ? m.texto : null }; }) };
});

route('GET', '/api/chat/mensajes/:id', async (c) => {
  const id = toInt(c.params.id);
  if (!(await convVisibles(c)).some((v) => v.id === id)) throw notFound('Conversación no encontrada');
  const rows = (await D.select('mensajes', { select: '*', conversacion_id: 'eq.' + id, order: 'created_at.desc', limit: 200 })).reverse();
  const [us, as] = await Promise.all([
    D.byIds('usuarios', rows.map((m) => m.remitente_id), 'id,nombre_completo,cargo'),
    D.byIds('activos_maestros', rows.map((m) => m.activo_compartido_id), 'id,nombre,codigo_inventario,numero_serie')
  ]);
  const UM = new Map(us.map((u) => [u.id, u])), AM = new Map(as.map((a) => [a.id, a]));
  return {
    mensajes: rows.map((m) => {
      const u = UM.get(m.remitente_id) || {}, a = AM.get(m.activo_compartido_id);
      return {
        id: m.id, remitente_id: m.remitente_id, remitente_nombre: u.nombre_completo || 'Usuario', remitente_cargo: u.cargo || '', texto: m.texto, created_at: co(m.created_at),
        activo_compartido_id: a ? a.id : null, activo_nombre: a ? a.nombre : null, activo_codigo: a ? a.codigo_inventario : null, activo_serie: a ? a.numero_serie : null
      };
    })
  };
});

route('POST', '/api/chat/mensajes', async (c) => {
  const b = c.body, id = toInt(b.conversacion_id);
  if (!(await convVisibles(c)).some((v) => v.id === id)) throw notFound('Conversación no encontrada');
  const texto = str(b.texto, 2000);
  const a = b.activo_id && UUID.test(String(b.activo_id)) ? await getActivo(b.activo_id) : null;
  if (!texto && !a) throw bad('El mensaje está vacío');
  const r = await D.insert('mensajes', { conversacion_id: id, remitente_id: c.user.id, texto, activo_compartido_id: a ? a.id : null });
  return { ok: true, mensaje_id: r[0] && r[0].id };
});

// ============================================================================
// CALIDAD Y AUDITORÍAS
// ============================================================================
async function checklistItems() {
  return cached('checklist', 60000, async () => {
    let lista = (await D.select('listas_chequeo', { select: 'id', activa: 'eq.true', order: 'id.desc', limit: 1 }))[0];
    if (!lista) lista = (await D.select('listas_chequeo', { select: 'id', order: 'id.desc', limit: 1 }))[0];
    if (!lista) return [];
    return D.select('lista_chequeo_items', { select: 'id,orden,pregunta', lista_id: 'eq.' + lista.id, order: 'orden.asc' });
  });
}
route('GET', '/api/calidad/lista-chequeo', async () => ({ items: await checklistItems() }));

async function auditoriaViews(list) {
  if (!list.length) return [];
  const [L, us, hz] = await Promise.all([
    lookups(), D.byIds('usuarios', list.map((a) => a.auditor_id), 'id,nombre_completo'),
    D.byIds('hallazgos', list.map((a) => a.id), 'id,auditoria_id', 'auditoria_id')
  ]);
  const UM = new Map(us.map((u) => [u.id, u]));
  return list.map((a) => ({
    id: a.id, codigo: a.codigo, titulo: a.titulo, regional_id: a.regional_id, regional_nombre: (L.R.get(a.regional_id) || {}).nombre || '-',
    sede_id: a.sede_id, sede_nombre: (L.S.get(a.sede_id) || {}).nombre || null, tipo_alcance: a.tipo_alcance, fecha_programada: a.fecha_programada,
    auditor_nombre: (UM.get(a.auditor_id) || {}).nombre_completo || '-', porcentaje_cumplimiento: a.porcentaje_cumplimiento == null ? 0 : Number(a.porcentaje_cumplimiento),
    total_hallazgos: hz.filter((h) => h.auditoria_id === a.id).length, estado: a.estado, resultado_final: a.resultado_final
  }));
}

route('GET', '/api/calidad/auditorias', async (c) => {
  const rows = await D.select('auditorias', [['select', '*'], ...scopePair(c), ['order', 'id.desc'], ['limit', 300]]);
  return { auditorias: await auditoriaViews(rows) };
});

route('GET', '/api/calidad/auditorias/:id', async (c) => {
  const au = (await D.select('auditorias', { select: '*', id: 'eq.' + toInt(c.params.id), limit: 1 }))[0];
  if (!au) throw notFound('Auditoría no encontrada');
  assertScope(c, au.regional_id);
  const [v] = await auditoriaViews([au]);
  const det = await D.fetchAll('auditoria_detalle', [['select', 'id,activo_id,resultado_activo,porcentaje_activo'], ['auditoria_id', 'eq.' + au.id], ['order', 'id.asc']]);
  const as = await D.byIds('activos_maestros', det.map((d) => d.activo_id), 'id,nombre,codigo_inventario,numero_serie');
  const AM = new Map(as.map((a) => [a.id, a]));
  v.detalles = det.map((d) => {
    const a = AM.get(d.activo_id) || {};
    return { activo_id: d.activo_id, activo_nombre: a.nombre || 'Activo', codigo_inventario: a.codigo_inventario || null, numero_serie: a.numero_serie || null, evaluado: d.resultado_activo != null, porcentaje: d.porcentaje_activo };
  });
  return { auditoria: v };
});

route('POST', '/api/calidad/auditorias', async (c) => {
  const b = c.body, L = await lookups(), regional = toInt(b.regional_id), sede = toInt(b.sede_id);
  if (!b.titulo) throw bad('El título es obligatorio');
  if (!L.R.get(regional) || !L.S.get(sede) || L.S.get(sede).regional_id !== regional) throw bad('Seleccione una regional y una sede válidas');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_programada || '')) throw bad('Fecha programada inválida');
  let ids = (await D.fetchAll('activos_maestros', [['select', 'id'], ['sede_id', 'eq.' + sede], ['order', 'id.asc']])).map((a) => a.id);
  const alcance = b.tipo_alcance === 'MUESTRA_ALEATORIA' ? 'MUESTRA_ALEATORIA' : 'SEDE_COMPLETA';
  if (alcance === 'MUESTRA_ALEATORIA') {
    for (let i = ids.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    ids = ids.slice(0, Math.min(ids.length, Math.max(5, Math.ceil(ids.length * 0.2))));
  }
  const last = (await D.select('auditorias', { select: 'id', order: 'id.desc', limit: 1 }))[0];
  const codigo = `AUD-${b.fecha_programada.slice(0, 4)}-${pad((last ? last.id : 0) + 1, 4)}`;
  const au = (await D.insert('auditorias', { codigo, titulo: str(b.titulo, 200), regional_id: regional, sede_id: sede, auditor_id: c.user.id, fecha_programada: b.fecha_programada, tipo_alcance: alcance, estado: 'PROGRAMADA' }))[0];
  for (let i = 0; i < ids.length; i += 300) await D.insert('auditoria_detalle', ids.slice(i, i + 300).map((activo_id) => ({ auditoria_id: au.id, activo_id })), false);
  await notify(c, { titulo: 'Auditoría programada', mensaje: `${codigo}: ${au.titulo} (${au.fecha_programada}).`, regional_id: regional });
  return { ok: true, auditoria_id: au.id, message: ids.length ? `Auditoría ${codigo} programada con ${ids.length} activo(s) en alcance` : `Auditoría ${codigo} programada, pero la sede aún no tiene activos en alcance`, advertencias: c.advertencias };
}, { roles: ['ADMINISTRADOR', 'CALIDAD / AUDITOR'] });

route('POST', '/api/calidad/evaluar-activo', async (c) => {
  const b = c.body, auId = toInt(b.auditoria_id);
  const au = (await D.select('auditorias', { select: '*', id: 'eq.' + auId, limit: 1 }))[0];
  if (!au) throw notFound('Auditoría no encontrada');
  if (!UUID.test(String(b.activo_id))) throw bad('Activo inválido');
  const det = (await D.select('auditoria_detalle', { select: 'id', auditoria_id: 'eq.' + auId, activo_id: 'eq.' + b.activo_id, limit: 1 }))[0];
  if (!det) throw bad('El activo no pertenece al alcance de la auditoría');
  const resp = Array.isArray(b.respuestas) ? b.respuestas : [];
  if (!resp.length) throw bad('Debe responder la lista de chequeo');
  const items = await checklistItems();
  let si = 0, no = 0;
  const filas = resp.map((r) => {
    const v = ['SI', 'NO', 'NO_APLICA'].includes(r.respuesta) ? r.respuesta : 'NO_APLICA';
    if (v === 'SI') si++; else if (v === 'NO') no++;
    return { auditoria_detalle_id: det.id, item_id: toInt(r.item_id), respuesta: v, observacion: str(r.observacion, 500) || null, _crit: r.criticidad };
  }).filter((r) => r.item_id);
  const pct = si + no ? Math.round((si / (si + no)) * 1000) / 10 : 100;
  await D.remove('auditoria_respuestas', { auditoria_detalle_id: 'eq.' + det.id });
  await D.insert('auditoria_respuestas', filas.map(({ _crit, ...f }) => f), false);
  await D.update('auditoria_detalle', { id: 'eq.' + det.id }, { resultado_activo: pct >= 90 ? 'CONFORME' : 'NO_CONFORME', porcentaje_activo: pct, observaciones: str(b.observaciones, 1000) || null });
  // Hallazgos por cada "NO" (se reemplazan los abiertos previos de este activo en esta auditoría)
  await safe(c, 'hallazgos', async () => {
    await D.remove('hallazgos', { auditoria_id: 'eq.' + auId, activo_id: 'eq.' + b.activo_id, estado: 'eq.ABIERTO' });
    const nuevos = filas.filter((f) => f.respuesta === 'NO');
    if (!nuevos.length) return;
    const last = (await D.select('hallazgos', { select: 'id', order: 'id.desc', limit: 1 }))[0];
    let n = (last ? last.id : 0) + 1;
    const anio = todayCO().slice(0, 4);
    await D.insert('hallazgos', nuevos.map((f, i) => {
      const it = items.find((x) => x.id === f.item_id);
      return {
        codigo: `HAL-${anio}-${pad(n + i, 4)}`, auditoria_id: auId, activo_id: b.activo_id, regional_id: au.regional_id, sede_id: au.sede_id,
        descripcion: f.observacion || (it ? `Incumple: ${it.pregunta}` : 'Incumplimiento detectado'),
        criticidad: ['BAJA', 'MEDIA', 'ALTA', 'CRITICA'].includes(resp.find((r) => toInt(r.item_id) === f.item_id).criticidad) ? resp.find((r) => toInt(r.item_id) === f.item_id).criticidad : 'MEDIA',
        fecha_compromiso: addDays(todayCO(), 15), estado: 'ABIERTO'
      };
    }), false);
  });
  const todos = await D.select('auditoria_detalle', { select: 'resultado_activo,porcentaje_activo', auditoria_id: 'eq.' + auId, limit: 5000 });
  const evaluados = todos.filter((d) => d.resultado_activo != null);
  const prom = evaluados.length ? Math.round((evaluados.reduce((s, d) => s + Number(d.porcentaje_activo || 0), 0) / evaluados.length) * 10) / 10 : null;
  const completa = evaluados.length >= todos.length;
  const final = completa ? (prom >= 90 ? 'CONFORME' : 'NO_CONFORME') : null;
  await D.update('auditorias', { id: 'eq.' + auId }, { porcentaje_cumplimiento: prom, estado: final || 'EN EJECUCION', resultado_final: final, fecha_ejecucion: todayCO(), updated_at: nowISO() });
  await registrarInventarioFisico(c, (await getActivo(b.activo_id)) || { id: b.activo_id }, { observaciones: 'Verificación en auditoría ' + au.codigo });
  return { ok: true, porcentaje: pct, message: `Evaluación registrada. Cumplimiento del activo: ${pct}%${final ? ` · Auditoría finalizada: ${final}` : ''}`, advertencias: c.advertencias };
}, { roles: ['ADMINISTRADOR', 'CALIDAD / AUDITOR'] });

// ============================================================================
// HALLAZGOS, NOVEDADES, MANTENIMIENTOS, MOVIMIENTOS
// ============================================================================
async function hallazgoViews(list) {
  const [L, as, aus] = await Promise.all([
    lookups(), D.byIds('activos_maestros', list.map((h) => h.activo_id), 'id,nombre,codigo_inventario'), D.byIds('auditorias', list.map((h) => h.auditoria_id), 'id,codigo')
  ]);
  const AM = new Map(as.map((a) => [a.id, a])), UM = new Map(aus.map((a) => [a.id, a]));
  return list.map((h) => ({
    id: h.id, codigo: h.codigo, auditoria_codigo: (UM.get(h.auditoria_id) || {}).codigo || null, descripcion: h.descripcion,
    activo_nombre: (AM.get(h.activo_id) || {}).nombre || '', codigo_inventario: (AM.get(h.activo_id) || {}).codigo_inventario || '',
    regional_nombre: (L.R.get(h.regional_id) || {}).nombre || '-', sede_nombre: (L.S.get(h.sede_id) || {}).nombre || '',
    criticidad: h.criticidad, fecha_compromiso: h.fecha_compromiso, estado: h.estado, accion_realizada: h.accion_correctiva || '', evidencia_correccion: h.evidencia_correccion || ''
  }));
}
route('GET', '/api/hallazgos', async (c) => {
  const rows = await D.select('hallazgos', [['select', '*'], ...scopePair(c), ['order', 'id.desc'], ['limit', 500]]);
  return { hallazgos: await hallazgoViews(rows) };
});

route('POST', '/api/hallazgos/:id/actualizar', async (c) => {
  const id = toInt(c.params.id), b = c.body;
  const h = (await D.select('hallazgos', { select: '*', id: 'eq.' + id, limit: 1 }))[0];
  if (!h) throw notFound('Hallazgo no encontrado');
  assertScope(c, h.regional_id);
  if (!['ABIERTO', 'EN PROCESO', 'PENDIENTE DE EVIDENCIA', 'EN VALIDACIÓN', 'CERRADO'].includes(b.estado)) throw bad('Estado inválido');
  const evid = str(b.evidencia_correccion, 4000).trim();
  if (b.estado === 'CERRADO' && !evid && !h.evidencia_correccion) throw bad('No se puede cerrar un hallazgo sin evidencia fotográfica o documental.');
  const patch = { estado: b.estado, updated_at: nowISO() };
  const accion = str(b.accion_realizada, 2000).trim();
  if (accion) patch.accion_correctiva = accion;
  if (evid) patch.evidencia_correccion = evid;
  if (b.estado === 'CERRADO') patch.fecha_ejecucion = todayCO();
  await D.update('hallazgos', { id: 'eq.' + id }, patch);
  if (accion || evid) await safe(c, 'acción correctiva', () => D.insert('acciones_correctivas', { hallazgo_id: id, descripcion: accion || 'Evidencia registrada', usuario_id: c.user.id, evidencia_url: evid || null }, false));
  return { ok: true, advertencias: c.advertencias };
});

async function regionalOfActivos(ids) {
  const as = await D.byIds('activos_maestros', ids, 'id,nombre,codigo_inventario,regional_id');
  return new Map(as.map((a) => [a.id, a]));
}

route('GET', '/api/novedades', async (c) => {
  const rows = await D.select('novedades', [['select', '*'], ['order', 'fecha.desc'], ['limit', c.scope ? 1000 : 300]]);
  const AM = await regionalOfActivos(rows.map((n) => n.activo_id));
  return {
    novedades: rows.filter((n) => inScope(c, (AM.get(n.activo_id) || {}).regional_id)).slice(0, 300).map((n) => ({
      id: n.id, fecha: co(n.fecha), activo_nombre: (AM.get(n.activo_id) || {}).nombre || 'Activo', codigo_inventario: (AM.get(n.activo_id) || {}).codigo_inventario || '',
      tipo_novedad: n.tipo_novedad, campo_modificado: n.campo_modificado, valor_anterior: n.valor_anterior, valor_nuevo: n.valor_nuevo, justificacion: n.justificacion, estado: n.estado
    }))
  };
});

route('GET', '/api/mantenimientos', async (c) => {
  const rows = await D.select('mantenimientos', [['select', '*'], ['order', 'fecha_solicitud.desc'], ['limit', c.scope ? 1000 : 300]]);
  const AM = await regionalOfActivos(rows.map((m) => m.activo_id));
  return { mantenimientos: rows.filter((m) => inScope(c, (AM.get(m.activo_id) || {}).regional_id)).slice(0, 300).map((m) => ({ ...m, activo_nombre: (AM.get(m.activo_id) || {}).nombre || 'Activo' })) };
});

async function movViews(rows) {
  const L = await lookups();
  const [as, ks, us] = await Promise.all([
    D.byIds('activos_maestros', rows.map((m) => m.activo_id), 'id,nombre,codigo_inventario'),
    D.byIds('colaboradores', rows.flatMap((m) => [m.responsable_anterior_id, m.responsable_nuevo_id]), 'id,nombre_completo'),
    D.byIds('usuarios', rows.map((m) => m.usuario_id), 'id,nombre_completo')
  ]);
  const AM = new Map(as.map((x) => [x.id, x])), KM = new Map(ks.map((x) => [x.id, x])), UM = new Map(us.map((x) => [x.id, x]));
  const lugar = (rid, sid) => [(L.R.get(rid) || {}).nombre, (L.S.get(sid) || {}).nombre].filter(Boolean).join(' / ') || null;
  return rows.map((m) => ({
    id: m.id, fecha: co(m.fecha), activo_id: m.activo_id, activo_nombre: (AM.get(m.activo_id) || {}).nombre || 'Activo', codigo_inventario: (AM.get(m.activo_id) || {}).codigo_inventario || '',
    tipo_movimiento: m.tipo_movimiento, motivo: m.motivo || m.observaciones || '',
    resp_ant_nombre: (KM.get(m.responsable_anterior_id) || {}).nombre_completo || null, resp_nvo_nombre: (KM.get(m.responsable_nuevo_id) || {}).nombre_completo || null,
    ubicacion_anterior: m.ubicacion_anterior || lugar(m.regional_anterior_id, m.sede_anterior_id), ubicacion_nueva: m.ubicacion_nueva || lugar(m.regional_nueva_id, m.sede_nueva_id),
    usuario_nombre: (UM.get(m.usuario_id) || {}).nombre_completo || 'Sistema'
  }));
}
route('GET', '/api/movimientos', async (c) => {
  const rows = await D.select('movimientos', [['select', '*'], ['order', 'fecha.desc'], ['limit', c.scope ? 1000 : 300]]);
  const AM = await regionalOfActivos(rows.map((m) => m.activo_id));
  return { movimientos: await movViews(rows.filter((m) => inScope(c, (AM.get(m.activo_id) || {}).regional_id)).slice(0, 300)) };
});

// ============================================================================
// NOTIFICACIONES Y USUARIOS
// ============================================================================
route('GET', '/api/notificaciones', async (c) => ({
  notificaciones: (await D.select('notificaciones', { select: 'id,titulo,mensaje,tipo,link,leida,created_at', usuario_id: 'eq.' + c.user.id, order: 'created_at.desc', limit: 50 }))
    .map((n) => ({ ...n, created_at: co(n.created_at), leida: !!n.leida }))
}));
route('POST', '/api/notificaciones/leer', async (c) => {
  await D.update('notificaciones', { usuario_id: 'eq.' + c.user.id, leida: 'eq.false' }, { leida: true });
  return { ok: true };
});

route('GET', '/api/usuarios', async () => {
  const [L, us, ur] = await Promise.all([lookups(), D.fetchAll('usuarios', [['select', 'id,nombre_completo,email,cargo,rol_id,activo'], ['order', 'nombre_completo.asc']]), D.fetchAll('usuario_regional', [['select', 'usuario_id,regional_id']])]);
  return { usuarios: us.map((u) => ({ id: u.id, nombre_completo: u.nombre_completo, email: u.email, cargo: u.cargo, activo: u.activo !== false, rol_nombre: canonRole((L.ROL.get(u.rol_id) || {}).nombre), regionales: ur.filter((x) => x.usuario_id === u.id).map((x) => x.regional_id) })) };
}, { roles: ['ADMINISTRADOR'] });

// ============================================================================
// REPORTES (22 tipos, CSV)
// ============================================================================
const REPORTES = ['inventario_general_nacional', 'inventario_por_regional', 'inventario_por_sede', 'inventario_por_responsable', 'activos_sin_codigo', 'activos_sin_serial', 'activos_sin_responsable', 'activos_sin_ubicacion', 'activos_incompletos', 'activos_nuevos', 'activos_no_encontrados', 'movimientos_de_activos', 'activos_de_excolaboradores', 'inventarios_conciliados', 'auditorias_por_regional', 'informes_de_calidad', 'hallazgos', 'acciones_correctivas', 'programaciones_de_inventario', 'cumplimiento_de_jornadas', 'historial_de_modificaciones', 'reporte_fotografico'];

async function reportData(c, n) {
  const H = ['Código', 'Serial', 'Nombre', 'Categoría', 'Regional', 'Sede', 'Ubicación', 'Responsable', 'Estado físico', 'Estado operativo', 'Estado registro'];
  const row = (v) => [v.codigo_inventario || '', v.numero_serie || '', v.nombre, v.categoria_nombre || '', v.regional_nombre || '', v.sede_nombre || '', v.ubicacion_especifica, v.responsable_nombre || '', v.estado_fisico, v.estado_operativo, v.estado_registro];
  const assets = async (f, sort) => {
    const rows = await D.fetchAll('activos_maestros', [['select', ASSET_COLS], ...scopePair(c), ['order', 'id.asc']]);
    const L = await lookups(), colabs = await colabsAll(), CM = new Map(colabs.map((k) => [k.id, k]));
    const views = rows.map((a) => {
      const res = CM.get(a.responsable_id), cat = L.C.get(a.categoria_id);
      return { ...a, categoria_nombre: cat ? cat.nombre : '', regional_nombre: (L.R.get(a.regional_id) || {}).nombre || '', sede_nombre: (L.S.get(a.sede_id) || {}).nombre || '', responsable_nombre: res ? res.nombre_completo : '', responsable_estado: res ? res.estado_vinculacion : null, es_incompleto: incompleto(a) };
    });
    return { h: H, r: views.filter(f || (() => true)).sort(sort || (() => 0)).map(row) };
  };
  const cmp = (k) => (a, b) => String(a[k] || '').localeCompare(String(b[k] || ''));
  switch (n) {
    case 1: return assets();
    case 2: return assets(null, cmp('regional_nombre'));
    case 3: return assets(null, cmp('sede_nombre'));
    case 4: return assets(null, cmp('responsable_nombre'));
    case 5: return assets((v) => blank(v.codigo_inventario));
    case 6: return assets((v) => blank(v.numero_serie));
    case 7: return assets((v) => !v.responsable_id);
    case 8: return assets((v) => !v.sede_id || blank(v.ubicacion_especifica));
    case 9: return assets((v) => v.es_incompleto);
    case 10: return assets((v) => /^NUEVO/i.test(v.estado_registro || ''));
    case 11: return assets((v) => /NO ENCONTRADO/i.test((v.estado_operativo || '') + ' ' + (v.estado_registro || '')));
    case 13: return assets((v) => isRetirado({ estado_vinculacion: v.responsable_estado }));
    case 14: {
      const inv = new Set((await D.fetchAll('inventarios_fisicos', [['select', 'activo_id'], ['order', 'id.asc']])).map((x) => x.activo_id));
      return assets((v) => inv.has(v.id));
    }
    case 12: {
      const rows = await D.select('movimientos', [['select', '*'], ['order', 'fecha.desc'], ['limit', 1000]]);
      const AM = await regionalOfActivos(rows.map((m) => m.activo_id));
      const v = await movViews(rows.filter((m) => inScope(c, (AM.get(m.activo_id) || {}).regional_id)));
      return { h: ['Fecha', 'Activo', 'Código', 'Tipo', 'Motivo', 'Anterior', 'Nuevo', 'Usuario'], r: v.map((m) => [m.fecha, m.activo_nombre, m.codigo_inventario, m.tipo_movimiento, m.motivo, m.resp_ant_nombre || m.ubicacion_anterior || '', m.resp_nvo_nombre || m.ubicacion_nueva || '', m.usuario_nombre]) };
    }
    case 15: case 16: {
      const v = await auditoriaViews(await D.select('auditorias', [['select', '*'], ...scopePair(c), ['order', 'id.desc'], ['limit', 1000]]));
      return { h: ['Código', 'Título', 'Regional', 'Sede', 'Fecha', 'Cumplimiento %', 'Hallazgos', 'Estado'], r: v.map((a) => [a.codigo, a.titulo, a.regional_nombre, a.sede_nombre || '', a.fecha_programada, a.porcentaje_cumplimiento, a.total_hallazgos, a.resultado_final || a.estado]) };
    }
    case 17: case 18: {
      const v = await hallazgoViews(await D.select('hallazgos', [['select', '*'], ...scopePair(c), ...(n === 18 ? [['accion_correctiva', 'not.is.null']] : []), ['order', 'id.desc'], ['limit', 1000]]));
      return { h: ['Código', 'Auditoría', 'Descripción', 'Activo', 'Regional', 'Criticidad', 'Compromiso', 'Estado', 'Acción realizada', 'Evidencia'], r: v.map((h) => [h.codigo, h.auditoria_codigo || 'Directo', h.descripcion, h.activo_nombre, h.regional_nombre, h.criticidad, h.fecha_compromiso, h.estado, h.accion_realizada, h.evidencia_correccion]) };
    }
    case 19: case 20: {
      const v = await jornadaViews(await D.select('programaciones', [['select', '*'], ...scopePair(c), ['order', 'fecha_inicio.desc'], ['limit', 1000]]));
      return { h: ['Jornada', 'Tipo', 'Regional', 'Inicio', 'Fin', 'Meta', 'Verificados', 'Avance %', 'Estado'], r: v.map((j) => [j.titulo, j.tipo_actividad, j.regional_nombre, j.fecha_inicio, j.fecha_fin, j.meta_verificacion || j.total_activos_sede, j.activos_verificados, j.porcentaje_avance, j.estado]) };
    }
    case 21: {
      const rows = await D.select('novedades', [['select', '*'], ['order', 'fecha.desc'], ['limit', 1000]]);
      const AM = await regionalOfActivos(rows.map((x) => x.activo_id));
      return { h: ['Fecha', 'Activo', 'Campo', 'Anterior', 'Nuevo', 'Justificación'], r: rows.filter((x) => inScope(c, (AM.get(x.activo_id) || {}).regional_id)).map((x) => [co(x.fecha), (AM.get(x.activo_id) || {}).nombre || '', x.campo_modificado, x.valor_anterior, x.valor_nuevo, x.justificacion]) };
    }
    case 22: {
      const rows = await D.select('fotografias_activos', [['select', 'id,activo_id,tipo_foto,descripcion'], ['order', 'id.desc'], ['limit', 1000]]);
      const AM = await regionalOfActivos(rows.map((x) => x.activo_id));
      return { h: ['Activo', 'Código', 'Tipo de foto', 'Descripción'], r: rows.filter((f) => inScope(c, (AM.get(f.activo_id) || {}).regional_id)).map((f) => [(AM.get(f.activo_id) || {}).nombre || '', (AM.get(f.activo_id) || {}).codigo_inventario || '', f.tipo_foto, f.descripcion || '']) };
    }
    default: throw notFound('Reporte no existe');
  }
}
async function csvReport(c, n) {
  const d = await reportData(c, n);
  return { __raw: { type: 'text/csv; charset=utf-8', filename: `${REPORTES[n - 1]}_${todayCO()}.csv`, body: toCSV(d.h, d.r) } };
}
route('GET', '/api/reportes/:n', (c) => {
  const n = toInt(c.params.n);
  if (!n || n < 1 || n > 22) throw notFound('Reporte no existe');
  return csvReport(c, n);
});

// ============================================================================
// LOGS DE ERRORES
// ============================================================================
route('POST', '/api/logs/client-error', async (c) => {
  limit('clienterr:' + c.ip, 30, 60 * 1000);
  const b = c.body;
  await logError('ERROR', 'FRONTEND', b.mensaje || 'Error de cliente', `${b.stack || ''}\nURL: ${b.url || ''}`, c.user ? c.user.id : null, 'client', c.ip);
  return { ok: true };
}, { public: true });

async function logViews(rows) {
  const us = await D.byIds('usuarios', rows.map((e) => e.resuelto_por), 'id,nombre_completo');
  const UM = new Map(us.map((u) => [u.id, u]));
  return rows.map((e) => ({ ...e, fecha: co(e.fecha), resuelto_por: e.resuelto_por ? (UM.get(e.resuelto_por) || {}).nombre_completo || 'Usuario' : null }));
}
route('GET', '/api/logs/errores', async (c) => ({
  errores: await logViews(await D.select('logs_errores', { select: '*', order: 'fecha.desc', limit: Math.min(200, toInt(c.q.limit) || 30) }))
}), { roles: ['ADMINISTRADOR'] });

route('POST', '/api/logs/resolver/:id', async (c) => {
  if (!c.body.notas_solucion) throw bad('Indique las notas de la solución');
  await D.update('logs_errores', { id: 'eq.' + toInt(c.params.id) }, { resuelto: true, notas_solucion: str(c.body.notas_solucion, 2000), resuelto_por: c.user.id, fecha_resolucion: nowISO() });
  return { ok: true };
}, { roles: ['ADMINISTRADOR'] });

route('GET', '/api/logs/download', async () => {
  const rows = await logViews(await D.select('logs_errores', { select: '*', order: 'fecha.desc', limit: 1000 }));
  const body = rows.map((e) => `[${e.fecha}] [${e.nivel}] [${e.modulo || 'N/A'}] #${e.id} ${unesc(e.mensaje)} | ${e.resuelto ? 'SOLUCIONADO: ' + unesc(e.notas_solucion) : 'PENDIENTE'}${e.detalle_tecnico ? '\n    ' + unesc(e.detalle_tecnico).replace(/\n/g, '\n    ') : ''}`).join('\n') || 'Sin errores registrados.';
  return { __raw: { type: 'text/plain; charset=utf-8', filename: 'app_errors.log', body } };
}, { roles: ['ADMINISTRADOR'] });

// ============================================================================
// HANDLER PRINCIPAL
// ============================================================================
function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  for (const k of Object.keys(headers)) res.setHeader(k, headers[k]);
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(cleanOut(obj)), { 'Content-Type': 'application/json; charset=utf-8' });

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    try { return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString() : req.body); } catch (e) { return {}; }
  }
  const chunks = []; let size = 0;
  for await (const ch of req) { size += ch.length; if (size > 1e6) throw new HttpError(413, 'Solicitud demasiado grande'); chunks.push(ch); }
  const s = Buffer.concat(chunks).toString();
  try { return s ? JSON.parse(s) : {}; } catch (e) { return {}; }
}

module.exports = async function handler(req, res) {
  let ctx = { path: '', ip: '' };
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname;
    if (path === '/api/index' || path === '/api/index.js') path = '/api/' + (url.searchParams.get('__p') || '');
    path = path.replace(/\/+$/, '') || '/';
    const q = {};
    url.searchParams.forEach((v, k) => { if (k !== '__p') q[k] = v; });
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    let matched = null, pathMatched = false;
    for (const r of routes) {
      const m = r.rx.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      matched = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      break;
    }
    if (!matched) return json(res, pathMatched ? 405 : 404, { error: pathMatched ? 'Método no permitido' : `Ruta no encontrada: ${path}` });

    const mutating = method !== 'GET';
    const body = mutating ? sanitize(await readBody(req)) : {};
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : q.token;
    const payload = verifyToken(token);
    const user = payload && UUID.test(String(payload.uid)) ? await loadUser(payload.uid) : null;
    ctx = {
      user, body, q, params: matched.params, req, path, scope: user && user.rol_nombre === 'COORDINADOR' ? user.regionales || [] : null,
      ip: String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim()
    };

    if (!matched.r.opts.public && !user) return json(res, 401, { error: 'Sesión expirada' });
    if (matched.r.opts.roles && !matched.r.opts.roles.includes(user && user.rol_nombre)) throw forbid('Su rol no tiene permiso para esta acción');

    const out = await matched.r.handler(ctx);
    if (out && out.__raw) {
      return send(res, 200, out.__raw.body, { 'Content-Type': out.__raw.type, 'Content-Disposition': `attachment; filename="${out.__raw.filename}"` });
    }
    return json(res, 200, out);
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status >= 500 && err.status !== 503) await logError('CRITICAL', 'BACKEND', err.message, err.stack, ctx.user && ctx.user.id, ctx.path, ctx.ip);
      return json(res, err.status, { error: err.message });
    }
    console.error(err);
    await logError('CRITICAL', 'BACKEND', err.message, err.stack, ctx.user && ctx.user.id, ctx.path, ctx.ip);
    return json(res, 500, { error: 'Error interno del servidor. Quedó registrado en app_errors.log' });
  }
};
