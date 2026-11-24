// ============================================================================
// JARDINES DEL RENACER - API (Vercel Serverless Function)
// Todas las rutas /api/* se reescriben a esta función (ver vercel.json).
// ============================================================================
const crypto = require('crypto');
const { getDb, saveDb, persistence } = require('./_lib/store');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./_lib/security');
const { nowCO, todayCO, addDays, pad, sanitize, toCSV, unesc, norm } = require('./_lib/util');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const forbid = (m) => new HttpError(403, m || 'No tiene permisos para esta acción');
const notFound = (m) => new HttpError(404, m || 'Registro no encontrado');

const ESTADOS_FISICOS = ['BUENO', 'REGULAR', 'MALO', 'DAÑADO', 'PENDIENTE DE REVISIÓN'];
const ESTADOS_HALLAZGO = ['ABIERTO', 'EN PROCESO', 'PENDIENTE DE EVIDENCIA', 'EN VALIDACIÓN', 'CERRADO'];
const EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'jardinesdelrenacer.com').toLowerCase();

const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const byId = (arr, id) => arr.find((x) => x.id === id || (id != null && String(x.id) === String(id)));
const nextId = (arr) => arr.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;

// ---------- rate limit en memoria ----------
const hits = new Map();
function limit(key, max, ms) {
  const n = Date.now(); const h = hits.get(key);
  if (!h || h.reset < n) { hits.set(key, { n: 1, reset: n + ms }); return; }
  if (++h.n > max) throw new HttpError(429, 'Demasiados intentos. Espere unos minutos e intente de nuevo.');
}

// ---------- router ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, rx, keys, handler, opts });
}

// ---------- helpers de dominio ----------
const roleName = (db, u) => (byId(db.roles, u.rol_id) || {}).nombre;
const userView = (db, u) => ({
  id: u.id, nombre_completo: u.nombre_completo, email: u.email, cargo: u.cargo, rol_id: u.rol_id,
  rol_nombre: roleName(db, u), regionales: u.regionales || []
});
const inScope = (c, rid) => c.scope == null || (rid != null && c.scope.includes(rid));
const assertScope = (c, rid) => { if (!inScope(c, rid)) throw forbid('El recurso pertenece a una regional que no tiene asignada'); };

function activoView(db, a) {
  const reg = byId(db.regionales, a.regional_id), sed = byId(db.sedes, a.sede_id);
  const cat = byId(db.categorias, a.categoria_id), res = byId(db.colaboradores, a.responsable_id);
  return {
    id: a.id, id_origen: a.id_origen, codigo_inventario: a.codigo_inventario || null, numero_serie: a.numero_serie || null,
    nombre: a.nombre, marca: a.marca || '', modelo: a.modelo || '', categoria_id: a.categoria_id,
    categoria_nombre: cat ? cat.nombre : null, tipo_elemento: cat ? cat.nombre : '',
    regional_id: a.regional_id, regional_nombre: reg ? reg.nombre : null, sede_id: a.sede_id, sede_nombre: sed ? sed.nombre : null,
    ubicacion_especifica: a.ubicacion_especifica || '', responsable_id: a.responsable_id,
    responsable_nombre: res ? res.nombre_completo : null, responsable_estado: res ? res.estado_vinculacion : null,
    estado_fisico: a.estado_fisico, estado_operativo: a.estado_operativo, estado_registro: a.estado_registro,
    observaciones: a.observaciones || '', es_incompleto: !a.codigo_inventario || !a.numero_serie || !a.regional_id
  };
}
const visibleActivos = (c) => c.db.activos.filter((a) => c.scope == null || (a.regional_id && c.scope.includes(a.regional_id)));
const findActivo = (db, id) => db.activos.find((a) => a.id === String(id));
const movView = (db, m) => {
  const a = findActivo(db, m.activo_id), ra = byId(db.colaboradores, m.resp_ant_id), rn = byId(db.colaboradores, m.resp_nvo_id), u = byId(db.usuarios, m.usuario_id);
  return {
    id: m.id, fecha: m.fecha, activo_id: m.activo_id, activo_nombre: a ? a.nombre : 'Activo', codigo_inventario: a ? a.codigo_inventario : '',
    tipo_movimiento: m.tipo_movimiento, motivo: m.motivo, resp_ant_nombre: ra ? ra.nombre_completo : null,
    resp_nvo_nombre: rn ? rn.nombre_completo : null, ubicacion_anterior: m.ubicacion_anterior, ubicacion_nueva: m.ubicacion_nueva,
    usuario_nombre: u ? u.nombre_completo : 'Sistema'
  };
};
function addMov(db, a, tipo, motivo, o = {}) {
  db.movimientos.push({
    id: nextId(db.movimientos), activo_id: a.id, fecha: nowCO(), tipo_movimiento: tipo, motivo,
    resp_ant_id: o.resp_ant_id || null, resp_nvo_id: o.resp_nvo_id || null,
    ubicacion_anterior: o.ubic_ant || null, ubicacion_nueva: o.ubic_nva || null, usuario_id: o.usuario_id || null
  });
}
function notify(db, { titulo, mensaje, roles = null, regional_id = null, usuario_id = null }) {
  db.notificaciones.push({ id: nextId(db.notificaciones), usuario_id, roles, regional_id, titulo, mensaje, created_at: nowCO(), leida_por: [], link: null });
  if (db.notificaciones.length > 300) db.notificaciones.splice(0, db.notificaciones.length - 300);
}
function logError(db, nivel, modulo, mensaje, detalle, usuario) {
  db.errores.push({ id: nextId(db.errores), fecha: nowCO(), nivel, modulo, mensaje: String(mensaje).slice(0, 500), detalle_tecnico: String(detalle || '').slice(0, 3000), resuelto: false, notas_solucion: null, resuelto_por: null, usuario: usuario || null });
  if (db.errores.length > 500) db.errores.splice(0, db.errores.length - 500);
}

// Jornadas
function jornadaEstado(j) {
  const t = todayCO();
  if (j.finalizada) return 'FINALIZADO';
  if (j.meta_verificacion > 0 && j.verificados.length >= j.meta_verificacion) return 'FINALIZADO';
  if (t > j.fecha_fin) return 'VENCIDO';
  if (t >= j.fecha_inicio) return 'EN EJECUCION';
  return 'PROGRAMADO';
}
function jornadaView(db, j) {
  const reg = byId(db.regionales, j.regional_id), coord = byId(db.usuarios, j.coordinador_id);
  const total = db.activos.filter((a) => a.regional_id === j.regional_id && (!j.sedes_ids.length || j.sedes_ids.includes(a.sede_id))).length;
  const meta = j.meta_verificacion || total;
  return {
    id: j.id, titulo: j.titulo, tipo_actividad: j.tipo_actividad, regional_id: j.regional_id, regional_nombre: reg ? reg.nombre : '-',
    sedes: j.sedes_ids.map((id) => byId(db.sedes, id)).filter(Boolean).map((s) => ({ id: s.id, nombre: s.nombre })),
    fecha_inicio: j.fecha_inicio, fecha_fin: j.fecha_fin, hora_inicio: j.hora_inicio, hora_fin: j.hora_fin,
    coordinador_nombre: coord ? coord.nombre_completo : null, activos_verificados: j.verificados.length,
    meta_verificacion: j.meta_verificacion, total_activos_sede: total,
    porcentaje_avance: meta ? Math.min(100, Math.round((j.verificados.length / meta) * 100)) : 0, estado: jornadaEstado(j)
  };
}
function registrarVerificacion(db, a) {
  for (const j of db.jornadas) {
    if (j.regional_id === a.regional_id && jornadaEstado(j) === 'EN EJECUCION' && (!j.sedes_ids.length || j.sedes_ids.includes(a.sede_id)) && !j.verificados.includes(a.id)) j.verificados.push(a.id);
  }
}
const hallazgoView = (db, h) => {
  const a = findActivo(db, h.activo_id), au = byId(db.auditorias, h.auditoria_id), reg = byId(db.regionales, h.regional_id), sed = byId(db.sedes, h.sede_id);
  return {
    id: h.id, codigo: h.codigo, auditoria_codigo: au ? au.codigo : null, descripcion: h.descripcion, activo_nombre: a ? a.nombre : '',
    codigo_inventario: a ? a.codigo_inventario || '' : '', regional_nombre: reg ? reg.nombre : '-', sede_nombre: sed ? sed.nombre : '',
    criticidad: h.criticidad, fecha_compromiso: h.fecha_compromiso, estado: h.estado, accion_realizada: h.accion_realizada, evidencia_correccion: h.evidencia_correccion
  };
};
const auditoriaPct = (au) => {
  let si = 0, no = 0;
  Object.values(au.evaluaciones).forEach((e) => { si += e.si; no += e.no; });
  return si + no ? Math.round((si / (si + no)) * 1000) / 10 : 100;
};
function auditoriaView(db, au) {
  const reg = byId(db.regionales, au.regional_id), sed = byId(db.sedes, au.sede_id), aud = byId(db.usuarios, au.auditor_id);
  return {
    id: au.id, codigo: au.codigo, titulo: au.titulo, regional_id: au.regional_id, regional_nombre: reg ? reg.nombre : '-',
    sede_id: au.sede_id, sede_nombre: sed ? sed.nombre : null, tipo_alcance: au.tipo_alcance, fecha_programada: au.fecha_programada,
    auditor_nombre: aud ? aud.nombre_completo : '-', porcentaje_cumplimiento: auditoriaPct(au),
    total_hallazgos: db.hallazgos.filter((h) => h.auditoria_id === au.id).length, estado: au.estado, resultado_final: au.resultado_final,
    evaluados: Object.keys(au.evaluaciones).length, total_activos: au.detalle_ids.length
  };
}

// ============================================================================
// SALUD
// ============================================================================
route('GET', '/api/health', () => ({ ok: true, servicio: 'Jardines del Renacer API', persistencia: persistence(), hora: nowCO() }), { public: true });

// ============================================================================
// AUTENTICACIÓN
// ============================================================================
route('POST', '/api/auth/login', (c) => {
  limit('login:' + c.ip, 20, 5 * 60 * 1000);
  const id = String(c.body.email || '').trim().toLowerCase(), pw = String(c.body.password || '');
  if (!id || !pw) throw bad('Ingrese usuario y contraseña');
  const u = c.db.usuarios.find((x) => x.activo && (x.email.toLowerCase() === id || x.email.toLowerCase().split('@')[0] === id));
  if (!u || !verifyPassword(pw, u.pass)) throw bad('Usuario o contraseña incorrectos');
  return { token: signToken({ uid: u.id }), user: userView(c.db, u) };
}, { public: true });

route('POST', '/api/auth/register', (c) => {
  limit('register:' + c.ip, 10, 60 * 60 * 1000);
  const b = c.body, db = c.db;
  const email = String(b.email || '').trim().toLowerCase(), nombre = String(b.nombre_completo || '').trim();
  const password = String(b.password || '');
  if (!nombre || !email || !password) throw bad('Complete nombre, correo y contraseña');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Correo electrónico inválido');
  if (EMAIL_DOMAIN !== '*' && !email.endsWith('@' + EMAIL_DOMAIN)) throw bad(`Use su correo corporativo (@${EMAIL_DOMAIN})`);
  if (password.length < 6) throw bad('La contraseña debe tener al menos 6 caracteres');
  if (db.usuarios.some((u) => u.email.toLowerCase() === email)) throw new HttpError(409, 'Ya existe un usuario con ese correo');
  const rol = toInt(b.rol_id) || 2;
  if (rol === 1) throw forbid('El rol Administrador requiere aprobación: solicítelo a un administrador existente');
  if (![2, 3].includes(rol)) throw bad('Rol inválido');
  const regional = toInt(b.regional_id);
  if (rol === 2 && !byId(db.regionales, regional)) throw bad('El coordinador debe tener una regional asignada');
  const u = {
    id: nextId(db.usuarios), nombre_completo: nombre, email, cargo: b.cargo || '', rol_id: rol,
    regionales: rol === 2 ? [regional] : [], pass: hashPassword(password), activo: true
  };
  db.usuarios.push(u);
  notify(db, { titulo: 'Nuevo usuario registrado', mensaje: `${nombre} (${roleName(db, u)}) creó su cuenta.`, roles: ['ADMINISTRADOR'] });
  return { token: signToken({ uid: u.id }), user: userView(db, u) };
}, { public: true });

route('GET', '/api/auth/me', (c) => ({ user: userView(c.db, c.user) }));

// ============================================================================
// CATÁLOGOS
// ============================================================================
route('GET', '/api/regionales', (c) => ({
  regionales: c.db.regionales.map((r) => ({
    ...r, total_sedes: c.db.sedes.filter((s) => s.regional_id === r.id).length,
    total_activos: c.db.activos.filter((a) => a.regional_id === r.id).length
  }))
}));
route('GET', '/api/sedes', (c) => ({ sedes: c.db.sedes }));
route('GET', '/api/categorias', (c) => ({ categorias: c.db.categorias }));

// ============================================================================
// DASHBOARD
// ============================================================================
route('GET', '/api/dashboard', (c) => {
  const db = c.db, act = visibleActivos(c);
  const views = act.map((a) => activoView(db, a));
  const regs = db.regionales.filter((r) => inScope(c, r.id));
  const auds = db.auditorias.filter((a) => inScope(c, a.regional_id));
  const evaluadas = auds.filter((a) => Object.keys(a.evaluaciones).length);
  const jor = db.jornadas.filter((j) => inScope(c, j.regional_id));
  return {
    activos_kpis: {
      total_activos: views.length,
      incompletos: views.filter((v) => v.es_incompleto).length,
      sin_serial: views.filter((v) => !v.numero_serie).length,
      sin_codigo: views.filter((v) => !v.codigo_inventario).length,
      sin_regional: views.filter((v) => !v.regional_id).length,
      nuevos: views.filter((v) => String(v.estado_registro).startsWith('NUEVO')).length,
      activos_en_retirados: views.filter((v) => v.responsable_estado === 'RETIRADO').length
    },
    calidad_kpis: {
      total_auditorias: auds.length,
      promedio_cumplimiento: evaluadas.length ? evaluadas.reduce((s, a) => s + auditoriaPct(a), 0) / evaluadas.length : null
    },
    hallazgos_kpis: { abiertos: db.hallazgos.filter((h) => h.estado !== 'CERRADO' && inScope(c, h.regional_id)).length },
    calendario_kpis: { total_jornadas: jor.length, en_ejecucion: jor.filter((j) => jornadaEstado(j) === 'EN EJECUCION').length },
    por_regional: regs.map((r) => ({ id: r.id, nombre: r.nombre, cantidad: views.filter((v) => v.regional_id === r.id).length })).sort((a, b) => b.cantidad - a.cantidad),
    por_categoria: db.categorias.map((k) => ({ id: k.id, nombre: k.nombre, cantidad: views.filter((v) => v.categoria_id === k.id).length })).sort((a, b) => b.cantidad - a.cantidad)
  };
});

// ============================================================================
// INVENTARIO MAESTRO
// ============================================================================
route('GET', '/api/maestro', (c) => {
  const q = c.q, db = c.db;
  let items = visibleActivos(c).map((a) => activoView(db, a));
  const txt = norm(q.q || '');
  if (txt) items = items.filter((v) => norm([v.nombre, v.codigo_inventario, v.numero_serie, v.marca, v.modelo, v.responsable_nombre, v.regional_nombre, v.sede_nombre].join(' ')).includes(txt));
  if (q.regional_id) items = items.filter((v) => String(v.regional_id) === q.regional_id);
  if (q.sede_id) items = items.filter((v) => String(v.sede_id) === q.sede_id);
  if (q.categoria_id) items = items.filter((v) => String(v.categoria_id) === q.categoria_id);
  if (q.estado_fisico) items = items.filter((v) => v.estado_fisico === q.estado_fisico);
  if (q.estado_operativo) items = items.filter((v) => v.estado_operativo === q.estado_operativo);
  if (q.estado_registro) items = items.filter((v) => v.estado_registro === q.estado_registro);
  const f = { completos: (v) => !v.es_incompleto, incompletos: (v) => v.es_incompleto, sin_serial: (v) => !v.numero_serie, sin_codigo: (v) => !v.codigo_inventario, sin_regional: (v) => !v.regional_id }[q.integridad];
  if (f) items = items.filter(f);
  const size = Math.min(100, Math.max(1, toInt(q.page_size) || 15));
  const total = items.length, pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pages, Math.max(1, toInt(q.page) || 1));
  return { items: items.slice((page - 1) * size, page * size), total, page, page_size: size, total_pages: pages };
});

route('GET', '/api/maestro/export', (c) => csvReport(c, 1));

route('GET', '/api/maestro/:id', (c) => {
  const a = findActivo(c.db, c.params.id);
  if (!a) throw notFound('Activo no encontrado');
  assertScope(c, a.regional_id);
  const v = activoView(c.db, a);
  v.movimientos = c.db.movimientos.filter((m) => m.activo_id === a.id).sort((x, y) => (y.fecha > x.fecha ? 1 : -1)).map((m) => movView(c.db, m));
  v.fotografias = c.db.fotografias.filter((f) => f.activo_id === a.id);
  return { activo: v };
});

route('POST', '/api/activos/search-first', (c) => {
  const t = norm(c.body.q || '');
  if (!t) throw bad('Ingrese un término de búsqueda');
  const res = visibleActivos(c).map((a) => activoView(c.db, a)).filter((v) => norm([v.codigo_inventario, v.numero_serie, v.nombre, v.marca, v.modelo].join(' ')).includes(t));
  return { coincidencias: res.slice(0, 10) };
});

route('POST', '/api/activos/create', (c) => {
  const b = c.body, db = c.db;
  const nombre = String(b.nombre || '').trim();
  if (!nombre) throw bad('El nombre del activo es obligatorio');
  const regional = toInt(b.regional_id), sede = toInt(b.sede_id);
  if (regional) { if (!byId(db.regionales, regional)) throw bad('Regional inválida'); assertScope(c, regional); }
  else if (c.scope) throw bad('Debe seleccionar una regional');
  if (sede && (!byId(db.sedes, sede) || byId(db.sedes, sede).regional_id !== regional)) throw bad('La sede no pertenece a la regional seleccionada');
  const codigo = String(b.codigo_inventario || '').trim() || null, serie = String(b.numero_serie || '').trim() || null;
  if (codigo && db.activos.some((a) => a.codigo_inventario && a.codigo_inventario.toLowerCase() === codigo.toLowerCase())) throw new HttpError(409, 'Ya existe un activo con ese código de inventario. Use la consulta previa para actualizarlo.');
  if (serie && db.activos.some((a) => a.numero_serie && a.numero_serie.toLowerCase() === serie.toLowerCase())) throw new HttpError(409, 'Ya existe un activo con ese número de serie. Use la consulta previa para actualizarlo.');
  const now = nowCO();
  const a = {
    id: crypto.randomUUID(), id_origen: null, codigo_inventario: codigo, numero_serie: serie, nombre,
    categoria_id: toInt(b.categoria_id), marca: b.marca || '', modelo: b.modelo || '', regional_id: regional, sede_id: sede || null,
    ubicacion_especifica: b.ubicacion_especifica || '', responsable_id: null,
    estado_fisico: ESTADOS_FISICOS.includes(b.estado_fisico) ? b.estado_fisico : 'BUENO', estado_operativo: 'OPERATIVO',
    estado_registro: 'NUEVO - PENDIENTE DE VALIDACIÓN', observaciones: b.observaciones || '', verificado_en: null, created_at: now, updated_at: now
  };
  db.activos.push(a);
  addMov(db, a, 'REGISTRO', b.observaciones || 'Registro de activo nuevo', { ubic_nva: a.ubicacion_especifica, usuario_id: c.user.id });
  registrarVerificacion(db, a);
  notify(db, { titulo: 'Nuevo activo pendiente de validación', mensaje: `${nombre} fue registrado por ${c.user.nombre_completo}.`, roles: ['ADMINISTRADOR', 'CALIDAD / AUDITOR'], regional_id: regional });
  return { message: 'Activo registrado como NUEVO - PENDIENTE DE VALIDACIÓN', activo_id: a.id };
});

route('POST', '/api/activos/update-physical', (c) => {
  const b = c.body, db = c.db;
  const a = findActivo(db, b.activo_id);
  if (!a) throw notFound('Activo no encontrado');
  assertScope(c, a.regional_id);
  const regional = toInt(b.regional_id) || a.regional_id;
  if (!byId(db.regionales, regional)) throw bad('Regional inválida');
  assertScope(c, regional);
  let sede = toInt(b.sede_id);
  if (!sede && regional === a.regional_id) sede = a.sede_id;
  if (sede && (!byId(db.sedes, sede) || byId(db.sedes, sede).regional_id !== regional)) throw bad('La sede no pertenece a la regional seleccionada');
  const ubic = b.ubicacion_especifica != null ? String(b.ubicacion_especifica) : a.ubicacion_especifica;
  const fis = ESTADOS_FISICOS.includes(b.estado_fisico) ? b.estado_fisico : a.estado_fisico;
  const just = b.observaciones || 'Verificación física';
  const nombreReg = (id) => (byId(db.regionales, id) || {}).nombre || '';
  const nombreSed = (id) => (byId(db.sedes, id) || {}).nombre || '';
  const cambios = [];
  if (regional !== a.regional_id) cambios.push(['regional', nombreReg(a.regional_id), nombreReg(regional)]);
  if ((sede || null) !== (a.sede_id || null)) cambios.push(['sede', nombreSed(a.sede_id), nombreSed(sede)]);
  if (ubic !== (a.ubicacion_especifica || '')) cambios.push(['ubicacion_especifica', a.ubicacion_especifica, ubic]);
  if (fis !== a.estado_fisico) cambios.push(['estado_fisico', a.estado_fisico, fis]);
  const ubicAnt = a.ubicacion_especifica;
  const regAnt = a.regional_id;
  a.regional_id = regional; a.sede_id = sede || null; a.ubicacion_especifica = ubic; a.estado_fisico = fis;
  a.verificado_en = nowCO(); a.updated_at = a.verificado_en;
  if (cambios.length && String(a.estado_registro).startsWith('NUEVO') === false) a.estado_registro = 'VALIDADO';
  cambios.forEach(([campo, ant, nvo]) => db.novedades.push({
    id: nextId(db.novedades), activo_id: a.id, fecha: nowCO(), campo_modificado: campo, valor_anterior: ant, valor_nuevo: nvo,
    justificacion: just, estado: 'REGISTRADA', regional_id: regAnt, usuario_id: c.user.id
  }));
  const traslado = cambios.some(([k]) => k === 'regional' || k === 'sede' || k === 'ubicacion_especifica');
  addMov(db, a, traslado ? 'TRASLADO' : 'VERIFICACION FISICA', just, { ubic_ant: ubicAnt, ubic_nva: ubic, resp_ant_id: a.responsable_id, resp_nvo_id: a.responsable_id, usuario_id: c.user.id });
  registrarVerificacion(db, a);
  return { ok: true, cambios: cambios.length, message: 'Actualización registrada' };
});

// ============================================================================
// COLABORADORES
// ============================================================================
const totalActivosDe = (db, id) => db.activos.filter((a) => a.responsable_id === id).length;
const colabView = (db, k) => ({
  ...k, regional_nombre: (byId(db.regionales, k.regional_id) || {}).nombre || null, sede_nombre: (byId(db.sedes, k.sede_id) || {}).nombre || null,
  total_activos: totalActivosDe(db, k.id)
});

route('GET', '/api/colaboradores', (c) => ({
  colaboradores: c.db.colaboradores.filter((k) => c.scope == null || (k.regional_id && c.scope.includes(k.regional_id))).map((k) => colabView(c.db, k)).sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo))
}));

route('GET', '/api/colaboradores/retirados-con-activos', (c) => ({
  retirados: c.db.colaboradores.filter((k) => k.estado_vinculacion === 'RETIRADO' && inScope(c, k.regional_id)).map((k) => ({ ...colabView(c.db, k), activos_pendientes: totalActivosDe(c.db, k.id) })).filter((k) => k.activos_pendientes > 0)
}));

route('POST', '/api/colaboradores/reasignar-activos', (c) => {
  const db = c.db, origen = toInt(c.body.colaborador_origen_id), destino = toInt(c.body.colaborador_destino_id);
  const o = byId(db.colaboradores, origen);
  if (!o) throw notFound('Colaborador origen no encontrado');
  assertScope(c, o.regional_id);
  const d = destino ? byId(db.colaboradores, destino) : null;
  if (destino && (!d || d.estado_vinculacion !== 'ACTIVO')) throw bad('El colaborador destino no existe o no está activo');
  const lista = db.activos.filter((a) => a.responsable_id === o.id);
  lista.forEach((a) => {
    a.responsable_id = d ? d.id : null;
    if (!d) a.estado_operativo = 'EN BODEGA';
    a.updated_at = nowCO();
    addMov(db, a, d ? 'REASIGNACION' : 'DEVOLUCION', d ? `Reasignación por retiro de ${o.nombre_completo}` : `Devolución a stock por retiro de ${o.nombre_completo}`, { resp_ant_id: o.id, resp_nvo_id: d ? d.id : null, ubic_nva: d ? null : 'Stock disponible', usuario_id: c.user.id });
  });
  return { message: 'Activos reasignados', reasignados: lista.length };
});

route('POST', '/api/colaboradores', (c) => {
  const b = c.body, db = c.db;
  const doc = String(b.documento || '').trim(), nombre = String(b.nombre_completo || '').trim();
  if (!doc || !nombre) throw bad('Documento y nombre son obligatorios');
  if (db.colaboradores.some((k) => k.documento === doc)) throw new HttpError(409, 'Ya existe un colaborador con ese documento');
  const regional = toInt(b.regional_id), sede = toInt(b.sede_id);
  if (regional) { if (!byId(db.regionales, regional)) throw bad('Regional inválida'); assertScope(c, regional); }
  else if (c.scope) throw bad('Debe seleccionar una regional');
  const k = {
    id: nextId(db.colaboradores), documento: doc, nombre_completo: nombre, cargo: b.cargo || '', regional_id: regional, sede_id: sede || null,
    estado_vinculacion: 'ACTIVO', fecha_ingreso: b.fecha_ingreso || todayCO(), fecha_retiro: null
  };
  db.colaboradores.push(k);
  return { ok: true, colaborador: colabView(db, k) };
});

route('POST', '/api/colaboradores/:id', (c) => {
  const db = c.db, k = byId(db.colaboradores, toInt(c.params.id));
  if (!k) throw notFound('Colaborador no encontrado');
  assertScope(c, k.regional_id);
  const b = c.body;
  if (b.cargo != null) k.cargo = b.cargo;
  if (b.estado_vinculacion) {
    if (!['ACTIVO', 'RETIRADO'].includes(b.estado_vinculacion)) throw bad('Estado de vinculación inválido');
    const antes = k.estado_vinculacion;
    k.estado_vinculacion = b.estado_vinculacion;
    k.fecha_retiro = b.estado_vinculacion === 'RETIRADO' ? b.fecha_retiro || todayCO() : null;
    const n = totalActivosDe(db, k.id);
    if (antes !== 'RETIRADO' && b.estado_vinculacion === 'RETIRADO' && n > 0) {
      notify(db, { titulo: 'Colaborador retirado con activos pendientes', mensaje: `${k.nombre_completo} fue retirado y tiene ${n} activo(s) por devolver o reasignar.`, roles: ['ADMINISTRADOR', 'COORDINADOR'], regional_id: k.regional_id });
    }
  }
  return { ok: true, colaborador: colabView(db, k) };
});

// ============================================================================
// CALENDARIO / JORNADAS
// ============================================================================
route('GET', '/api/calendario', (c) => ({
  jornadas: c.db.jornadas.filter((j) => inScope(c, j.regional_id)).sort((a, b) => (b.fecha_inicio > a.fecha_inicio ? 1 : -1)).map((j) => jornadaView(c.db, j))
}));

route('GET', '/api/calendario/control-nacional', (c) => ({
  control_nacional: c.db.regionales.filter((r) => inScope(c, r.id)).map((r) => {
    const js = c.db.jornadas.filter((j) => j.regional_id === r.id);
    return { id: r.id, nombre: r.nombre, total_jornadas: js.length, en_ejecucion: js.filter((j) => jornadaEstado(j) === 'EN EJECUCION').length };
  })
}));

route('POST', '/api/calendario', (c) => {
  const b = c.body, db = c.db;
  const regional = toInt(b.regional_id);
  if (!b.titulo) throw bad('El nombre de la actividad es obligatorio');
  if (!byId(db.regionales, regional)) throw bad('Seleccione una regional válida');
  assertScope(c, regional);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_inicio || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_fin || '')) throw bad('Fechas inválidas');
  if (b.fecha_fin < b.fecha_inicio) throw bad('La fecha fin no puede ser anterior a la fecha de inicio');
  const sedes = (Array.isArray(b.sedes_ids) ? b.sedes_ids : []).map(toInt).filter((id) => { const s = byId(db.sedes, id); return s && s.regional_id === regional; });
  const coord = c.user.rol_id === 2 ? c.user : db.usuarios.find((u) => u.rol_id === 2 && u.regionales.includes(regional)) || c.user;
  const j = {
    id: nextId(db.jornadas), titulo: b.titulo, tipo_actividad: b.tipo_actividad || 'Verificación física', regional_id: regional, sedes_ids: sedes,
    fecha_inicio: b.fecha_inicio, fecha_fin: b.fecha_fin, hora_inicio: '08:00', hora_fin: '17:00', coordinador_id: coord.id,
    meta_verificacion: Math.max(0, toInt(b.meta_verificacion) || 0), verificados: [], historial: [], finalizada: false
  };
  db.jornadas.push(j);
  if (b.crear_chat) db.conversaciones.push({ id: nextId(db.conversaciones), titulo: `Jornada: ${j.titulo}`, regional_id: regional });
  notify(db, { titulo: 'Nueva jornada programada', mensaje: `${j.titulo} (${j.fecha_inicio} al ${j.fecha_fin}).`, regional_id: regional });
  return { ok: true, jornada: jornadaView(db, j) };
}, { roles: ['ADMINISTRADOR', 'COORDINADOR'] });

route('POST', '/api/calendario/:id/reprogramar', (c) => {
  const db = c.db, j = byId(db.jornadas, toInt(c.params.id)), b = c.body;
  if (!j) throw notFound('Jornada no encontrada');
  assertScope(c, j.regional_id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_inicio || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_fin || '')) throw bad('Fechas inválidas');
  if (b.fecha_fin < b.fecha_inicio) throw bad('La fecha fin no puede ser anterior a la fecha de inicio');
  if (!b.motivo) throw bad('El motivo de la reprogramación es obligatorio');
  j.historial.push({ fecha: nowCO(), anterior: `${j.fecha_inicio} al ${j.fecha_fin}`, nuevo: `${b.fecha_inicio} al ${b.fecha_fin}`, motivo: b.motivo, usuario_id: c.user.id });
  j.fecha_inicio = b.fecha_inicio; j.fecha_fin = b.fecha_fin; j.finalizada = false;
  notify(db, { titulo: 'Jornada reprogramada', mensaje: `${j.titulo}: ${b.fecha_inicio} al ${b.fecha_fin}. Motivo: ${b.motivo}`, regional_id: j.regional_id });
  return { ok: true, jornada: jornadaView(db, j) };
}, { roles: ['ADMINISTRADOR', 'COORDINADOR'] });

// ============================================================================
// CHAT
// ============================================================================
const convVisible = (c, v) => v.regional_id == null || c.scope == null || c.scope.includes(v.regional_id);

route('GET', '/api/chat/conversaciones', (c) => ({
  conversaciones: c.db.conversaciones.filter((v) => convVisible(c, v)).map((v) => {
    const ms = c.db.mensajes.filter((m) => m.conversacion_id === v.id);
    const last = ms[ms.length - 1];
    return { id: v.id, titulo: v.titulo, regional_id: v.regional_id, ultimo_mensaje: last ? last.texto : null };
  })
}));

route('GET', '/api/chat/mensajes/:id', (c) => {
  const db = c.db, conv = byId(db.conversaciones, toInt(c.params.id));
  if (!conv || !convVisible(c, conv)) throw notFound('Conversación no encontrada');
  return {
    mensajes: db.mensajes.filter((m) => m.conversacion_id === conv.id).slice(-200).map((m) => {
      const u = byId(db.usuarios, m.remitente_id), a = m.activo_id ? findActivo(db, m.activo_id) : null;
      return {
        id: m.id, remitente_id: m.remitente_id, remitente_nombre: u ? u.nombre_completo : 'Usuario', remitente_cargo: u ? u.cargo : '',
        texto: m.texto, created_at: m.created_at, activo_compartido_id: a ? a.id : null, activo_nombre: a ? a.nombre : null,
        activo_codigo: a ? a.codigo_inventario : null, activo_serie: a ? a.numero_serie : null
      };
    })
  };
});

route('POST', '/api/chat/mensajes', (c) => {
  const db = c.db, b = c.body, conv = byId(db.conversaciones, toInt(b.conversacion_id));
  if (!conv || !convVisible(c, conv)) throw notFound('Conversación no encontrada');
  const texto = String(b.texto || '').slice(0, 2000);
  const a = b.activo_id ? findActivo(db, b.activo_id) : null;
  if (!texto && !a) throw bad('El mensaje está vacío');
  const m = { id: nextId(db.mensajes), conversacion_id: conv.id, remitente_id: c.user.id, texto, activo_id: a ? a.id : null, created_at: nowCO() };
  db.mensajes.push(m);
  if (db.mensajes.length > 2000) db.mensajes.splice(0, db.mensajes.length - 2000);
  return { ok: true, mensaje_id: m.id };
});

// ============================================================================
// CALIDAD Y AUDITORÍAS
// ============================================================================
route('GET', '/api/calidad/lista-chequeo', (c) => ({ items: c.db.checklist }));

route('GET', '/api/calidad/auditorias', (c) => ({
  auditorias: c.db.auditorias.filter((a) => inScope(c, a.regional_id)).sort((a, b) => b.id - a.id).map((a) => auditoriaView(c.db, a))
}));

route('GET', '/api/calidad/auditorias/:id', (c) => {
  const db = c.db, au = byId(db.auditorias, toInt(c.params.id));
  if (!au) throw notFound('Auditoría no encontrada');
  assertScope(c, au.regional_id);
  const v = auditoriaView(db, au);
  v.detalles = au.detalle_ids.map((id) => findActivo(db, id)).filter(Boolean).map((a) => ({
    activo_id: a.id, activo_nombre: a.nombre, codigo_inventario: a.codigo_inventario, numero_serie: a.numero_serie,
    evaluado: !!au.evaluaciones[a.id], porcentaje: au.evaluaciones[a.id] ? au.evaluaciones[a.id].porcentaje : null
  }));
  return { auditoria: v };
});

route('POST', '/api/calidad/auditorias', (c) => {
  const db = c.db, b = c.body, regional = toInt(b.regional_id), sede = toInt(b.sede_id);
  if (!b.titulo) throw bad('El título es obligatorio');
  const s = byId(db.sedes, sede);
  if (!byId(db.regionales, regional) || !s || s.regional_id !== regional) throw bad('Seleccione una regional y una sede válidas');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_programada || '')) throw bad('Fecha programada inválida');
  let ids = db.activos.filter((a) => a.sede_id === sede).map((a) => a.id);
  const alcance = b.tipo_alcance === 'MUESTRA_ALEATORIA' ? 'MUESTRA_ALEATORIA' : 'SEDE_COMPLETA';
  if (alcance === 'MUESTRA_ALEATORIA') {
    for (let i = ids.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    ids = ids.slice(0, Math.min(ids.length, Math.max(5, Math.ceil(ids.length * 0.2))));
  }
  const au = {
    id: nextId(db.auditorias), codigo: `AUD-${b.fecha_programada.slice(0, 4)}-${pad(nextId(db.auditorias), 4)}`, titulo: b.titulo, regional_id: regional, sede_id: sede,
    tipo_alcance: alcance, fecha_programada: b.fecha_programada, auditor_id: c.user.id, estado: 'PROGRAMADA', resultado_final: null, detalle_ids: ids, evaluaciones: {}
  };
  db.auditorias.push(au);
  notify(db, { titulo: 'Auditoría programada', mensaje: `${au.codigo}: ${au.titulo} (${au.fecha_programada}).`, regional_id: regional });
  return { ok: true, auditoria_id: au.id, message: ids.length ? `Auditoría ${au.codigo} programada con ${ids.length} activo(s) en alcance` : `Auditoría ${au.codigo} programada, pero la sede aún no tiene activos en alcance` };
}, { roles: ['ADMINISTRADOR', 'CALIDAD / AUDITOR'] });

route('POST', '/api/calidad/evaluar-activo', (c) => {
  const db = c.db, b = c.body, au = byId(db.auditorias, toInt(b.auditoria_id));
  if (!au) throw notFound('Auditoría no encontrada');
  if (!au.detalle_ids.includes(String(b.activo_id))) throw bad('El activo no pertenece al alcance de la auditoría');
  const resp = Array.isArray(b.respuestas) ? b.respuestas : [];
  if (!resp.length) throw bad('Debe responder la lista de chequeo');
  let si = 0, no = 0, na = 0;
  const a = findActivo(db, b.activo_id);
  db.hallazgos = db.hallazgos.filter((h) => !(h.auditoria_id === au.id && h.activo_id === a.id && h.estado === 'ABIERTO'));
  resp.forEach((r) => {
    if (r.respuesta === 'SI') si++;
    else if (r.respuesta === 'NO') {
      no++;
      const item = db.checklist.find((x) => x.id === toInt(r.item_id));
      const n = nextId(db.hallazgos);
      db.hallazgos.push({
        id: n, codigo: `HAL-${todayCO().slice(0, 4)}-${pad(n, 4)}`, auditoria_id: au.id, activo_id: a.id, regional_id: au.regional_id, sede_id: au.sede_id,
        descripcion: r.observacion || (item ? `Incumple: ${item.pregunta}` : 'Incumplimiento detectado'),
        criticidad: ['BAJA', 'MEDIA', 'ALTA', 'CRITICA'].includes(r.criticidad) ? r.criticidad : 'MEDIA', fecha_compromiso: addDays(todayCO(), 15),
        estado: 'ABIERTO', accion_realizada: '', evidencia_correccion: '', historial: []
      });
    } else na++;
  });
  const pct = si + no ? Math.round((si / (si + no)) * 1000) / 10 : 100;
  au.evaluaciones[a.id] = { si, no, na, porcentaje: pct, observaciones: b.observaciones || '', fecha: nowCO(), auditor_id: c.user.id };
  a.verificado_en = nowCO();
  const total = auditoriaPct(au);
  if (Object.keys(au.evaluaciones).length >= au.detalle_ids.length) {
    au.resultado_final = total >= 90 ? 'CONFORME' : 'NO_CONFORME';
    au.estado = au.resultado_final;
  } else { au.estado = 'EN EJECUCION'; au.resultado_final = null; }
  return { ok: true, porcentaje: pct, message: `Evaluación registrada. Cumplimiento del activo: ${pct}%${au.resultado_final ? ` · Auditoría finalizada: ${au.resultado_final}` : ''}` };
}, { roles: ['ADMINISTRADOR', 'CALIDAD / AUDITOR'] });

// ============================================================================
// HALLAZGOS, NOVEDADES, MANTENIMIENTOS, MOVIMIENTOS
// ============================================================================
route('GET', '/api/hallazgos', (c) => ({
  hallazgos: c.db.hallazgos.filter((h) => inScope(c, h.regional_id)).sort((a, b) => b.id - a.id).map((h) => hallazgoView(c.db, h))
}));

route('POST', '/api/hallazgos/:id/actualizar', (c) => {
  const db = c.db, h = byId(db.hallazgos, toInt(c.params.id)), b = c.body;
  if (!h) throw notFound('Hallazgo no encontrado');
  assertScope(c, h.regional_id);
  if (!ESTADOS_HALLAZGO.includes(b.estado)) throw bad('Estado inválido');
  const evid = String(b.evidencia_correccion || '').trim();
  if (b.estado === 'CERRADO' && !evid && !h.evidencia_correccion) throw bad('No se puede cerrar un hallazgo sin evidencia fotográfica o documental.');
  h.historial.push({ fecha: nowCO(), de: h.estado, a: b.estado, usuario_id: c.user.id });
  h.estado = b.estado;
  if (b.accion_realizada) h.accion_realizada = b.accion_realizada;
  if (evid) h.evidencia_correccion = evid;
  return { ok: true, hallazgo: hallazgoView(db, h) };
});

const actReg = (db, id) => { const a = findActivo(db, id); return a ? a.regional_id : null; };

route('GET', '/api/novedades', (c) => ({
  novedades: c.db.novedades.filter((n) => inScope(c, n.regional_id != null ? n.regional_id : actReg(c.db, n.activo_id))).sort((a, b) => (b.fecha > a.fecha ? 1 : -1)).slice(0, 300).map((n) => {
    const a = findActivo(c.db, n.activo_id);
    return { ...n, activo_nombre: a ? a.nombre : 'Activo', codigo_inventario: a ? a.codigo_inventario : '' };
  })
}));

route('GET', '/api/mantenimientos', (c) => ({
  mantenimientos: c.db.mantenimientos.filter((m) => inScope(c, actReg(c.db, m.activo_id))).map((m) => {
    const a = findActivo(c.db, m.activo_id);
    return { ...m, activo_nombre: a ? a.nombre : 'Activo' };
  })
}));

route('GET', '/api/movimientos', (c) => ({
  movimientos: c.db.movimientos.filter((m) => inScope(c, actReg(c.db, m.activo_id))).sort((a, b) => (b.fecha > a.fecha ? 1 : -1)).slice(0, 300).map((m) => movView(c.db, m))
}));

// ============================================================================
// NOTIFICACIONES Y USUARIOS
// ============================================================================
const notifVisible = (c, n) =>
  (n.usuario_id == null || n.usuario_id === c.user.id) && (!n.roles || n.roles.includes(c.role)) && (n.regional_id == null || inScope(c, n.regional_id));

route('GET', '/api/notificaciones', (c) => ({
  notificaciones: c.db.notificaciones.filter((n) => notifVisible(c, n)).sort((a, b) => b.id - a.id).slice(0, 50).map((n) => ({
    id: n.id, titulo: n.titulo, mensaje: n.mensaje, created_at: n.created_at, link: n.link, leida: n.leida_por.includes(c.user.id)
  }))
}));

route('POST', '/api/notificaciones/leer', (c) => {
  c.db.notificaciones.forEach((n) => { if (notifVisible(c, n) && !n.leida_por.includes(c.user.id)) n.leida_por.push(c.user.id); });
  return { ok: true };
});

route('GET', '/api/usuarios', (c) => ({
  usuarios: c.db.usuarios.map((u) => ({ id: u.id, nombre_completo: u.nombre_completo, email: u.email, cargo: u.cargo, rol_nombre: roleName(c.db, u), regionales: u.regionales || [] }))
}), { roles: ['ADMINISTRADOR'] });

// ============================================================================
// REPORTES (22 tipos, CSV)
// ============================================================================
const REPORTES = [
  'inventario_general_nacional', 'inventario_por_regional', 'inventario_por_sede', 'inventario_por_responsable', 'activos_sin_codigo', 'activos_sin_serial',
  'activos_sin_responsable', 'activos_sin_ubicacion', 'activos_incompletos', 'activos_nuevos', 'activos_no_encontrados', 'movimientos_de_activos',
  'activos_de_excolaboradores', 'inventarios_conciliados', 'auditorias_por_regional', 'informes_de_calidad', 'hallazgos', 'acciones_correctivas',
  'programaciones_de_inventario', 'cumplimiento_de_jornadas', 'historial_de_modificaciones', 'reporte_fotografico'
];
function reportData(c, n) {
  const db = c.db;
  const H = ['Código', 'Serial', 'Nombre', 'Categoría', 'Regional', 'Sede', 'Ubicación', 'Responsable', 'Estado físico', 'Estado operativo', 'Estado registro'];
  const row = (v) => [v.codigo_inventario || '', v.numero_serie || '', v.nombre, v.categoria_nombre || '', v.regional_nombre || '', v.sede_nombre || '', v.ubicacion_especifica, v.responsable_nombre || '', v.estado_fisico, v.estado_operativo, v.estado_registro];
  const V = visibleActivos(c).map((a) => activoView(db, a));
  const assets = (f, sort) => ({ h: H, r: V.filter(f || (() => true)).sort(sort || (() => 0)).map(row) });
  const cmp = (k) => (a, b) => String(a[k] || '').localeCompare(String(b[k] || ''));
  switch (n) {
    case 1: return assets();
    case 2: return assets(null, cmp('regional_nombre'));
    case 3: return assets(null, cmp('sede_nombre'));
    case 4: return assets(null, cmp('responsable_nombre'));
    case 5: return assets((v) => !v.codigo_inventario);
    case 6: return assets((v) => !v.numero_serie);
    case 7: return assets((v) => !v.responsable_id);
    case 8: return assets((v) => !v.sede_id || !v.ubicacion_especifica);
    case 9: return assets((v) => v.es_incompleto);
    case 10: return assets((v) => String(v.estado_registro).startsWith('NUEVO'));
    case 11: return assets((v) => /NO ENCONTRADO/.test(v.estado_operativo + v.estado_registro));
    case 13: return assets((v) => v.responsable_estado === 'RETIRADO');
    case 14: return assets((v) => db.activos.find((a) => a.id === v.id).verificado_en);
    case 12: return { h: ['Fecha', 'Activo', 'Código', 'Tipo', 'Motivo', 'Anterior', 'Nuevo', 'Usuario'], r: db.movimientos.filter((m) => inScope(c, actReg(db, m.activo_id))).map((m) => movView(db, m)).map((m) => [m.fecha, m.activo_nombre, m.codigo_inventario, m.tipo_movimiento, m.motivo, m.resp_ant_nombre || m.ubicacion_anterior || '', m.resp_nvo_nombre || m.ubicacion_nueva || '', m.usuario_nombre]) };
    case 15: case 16: return { h: ['Código', 'Título', 'Regional', 'Sede', 'Fecha', 'Cumplimiento %', 'Hallazgos', 'Estado'], r: db.auditorias.filter((a) => inScope(c, a.regional_id)).map((a) => auditoriaView(db, a)).map((a) => [a.codigo, a.titulo, a.regional_nombre, a.sede_nombre || '', a.fecha_programada, a.porcentaje_cumplimiento, a.total_hallazgos, a.resultado_final || a.estado]) };
    case 17: case 18: return { h: ['Código', 'Auditoría', 'Descripción', 'Activo', 'Regional', 'Criticidad', 'Compromiso', 'Estado', 'Acción realizada', 'Evidencia'], r: db.hallazgos.filter((h) => inScope(c, h.regional_id) && (n === 17 || h.accion_realizada)).map((h) => hallazgoView(db, h)).map((h) => [h.codigo, h.auditoria_codigo || 'Directo', h.descripcion, h.activo_nombre, h.regional_nombre, h.criticidad, h.fecha_compromiso, h.estado, h.accion_realizada, h.evidencia_correccion]) };
    case 19: case 20: return { h: ['Jornada', 'Tipo', 'Regional', 'Inicio', 'Fin', 'Meta', 'Verificados', 'Avance %', 'Estado'], r: db.jornadas.filter((j) => inScope(c, j.regional_id)).map((j) => jornadaView(db, j)).map((j) => [j.titulo, j.tipo_actividad, j.regional_nombre, j.fecha_inicio, j.fecha_fin, j.meta_verificacion || j.total_activos_sede, j.activos_verificados, j.porcentaje_avance, j.estado]) };
    case 21: return { h: ['Fecha', 'Activo', 'Campo', 'Anterior', 'Nuevo', 'Justificación'], r: db.novedades.filter((x) => inScope(c, x.regional_id != null ? x.regional_id : actReg(db, x.activo_id))).map((x) => { const a = findActivo(db, x.activo_id); return [x.fecha, a ? a.nombre : '', x.campo_modificado, x.valor_anterior, x.valor_nuevo, x.justificacion]; }) };
    case 22: return { h: ['Activo', 'Código', 'Tipo de foto'], r: db.fotografias.filter((f) => inScope(c, actReg(db, f.activo_id))).map((f) => { const a = findActivo(db, f.activo_id); return [a ? a.nombre : '', a ? a.codigo_inventario || '' : '', f.tipo_foto]; }) };
    default: throw notFound('Reporte no existe');
  }
}
function csvReport(c, n) {
  const d = reportData(c, n);
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
route('POST', '/api/logs/client-error', (c) => {
  limit('clienterr:' + c.ip, 30, 60 * 1000);
  const b = c.body;
  logError(c.db, 'ERROR', 'FRONTEND', b.mensaje || 'Error de cliente', `${b.stack || ''}\nURL: ${b.url || ''}`, c.user ? c.user.email : null);
  return { ok: true };
}, { public: true });

route('GET', '/api/logs/errores', (c) => ({
  errores: c.db.errores.slice().sort((a, b) => b.id - a.id).slice(0, Math.min(200, toInt(c.q.limit) || 30))
}), { roles: ['ADMINISTRADOR'] });

route('POST', '/api/logs/resolver/:id', (c) => {
  const e = byId(c.db.errores, toInt(c.params.id));
  if (!e) throw notFound('Error no encontrado');
  if (!c.body.notas_solucion) throw bad('Indique las notas de la solución');
  e.resuelto = true; e.notas_solucion = c.body.notas_solucion; e.resuelto_por = c.user.nombre_completo;
  return { ok: true };
}, { roles: ['ADMINISTRADOR'] });

route('GET', '/api/logs/download', (c) => {
  const body = c.db.errores.map((e) => `[${e.fecha}] [${e.nivel}] [${e.modulo || 'N/A'}] #${e.id} ${unesc(e.mensaje)} | usuario=${e.usuario || '-'} | ${e.resuelto ? 'SOLUCIONADO: ' + unesc(e.notas_solucion) : 'PENDIENTE'}${e.detalle_tecnico ? '\n    ' + unesc(e.detalle_tecnico).replace(/\n/g, '\n    ') : ''}`).join('\n') || 'Sin errores registrados.';
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
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

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
  let db = null, ctx = null;
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
    db = await getDb(mutating);
    const body = mutating ? sanitize(await readBody(req)) : {};
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : q.token;
    const payload = verifyToken(token);
    const user = payload ? db.usuarios.find((u) => u.id === payload.uid && u.activo) : null;
    const role = user ? roleName(db, user) : null;
    ctx = {
      db, user, role, body, q, params: matched.params, req, scope: role === 'COORDINADOR' ? user.regionales || [] : null,
      ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
    };

    if (!matched.r.opts.public && !user) return json(res, 401, { error: 'Sesión expirada' });
    if (matched.r.opts.roles && !matched.r.opts.roles.includes(role)) throw forbid('Su rol no tiene permiso para esta acción');

    const out = await matched.r.handler(ctx);
    if (mutating) await saveDb();
    if (out && out.__raw) {
      return send(res, 200, out.__raw.body, { 'Content-Type': out.__raw.type, 'Content-Disposition': `attachment; filename="${out.__raw.filename}"` });
    }
    return json(res, 200, out);
  } catch (err) {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message });
    console.error(err);
    try {
      if (db) { logError(db, 'CRITICAL', 'BACKEND', err.message, err.stack, ctx && ctx.user ? ctx.user.email : null); await saveDb(); }
    } catch (e) { /* ignorar */ }
    return json(res, 500, { error: 'Error interno del servidor. Quedó registrado en app_errors.log' });
  }
};
