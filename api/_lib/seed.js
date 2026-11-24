// Datos iniciales de demostración (19 regionales, sedes, usuarios, activos, etc.)
const crypto = require('crypto');
const { hashPassword } = require('./security');
const { nowCO, todayCO, addDays, pad } = require('./util');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function uuid(n) {
  const h = crypto.createHash('md5').update('jr-activo-' + n).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const REGIONALES = [
  ['ANTIOQUIA', 'ANT'], ['ATLANTICO', 'ATL'], ['BOGOTA', 'BOG'], ['CALDAS', 'CAL'], ['CAUCA', 'CAU'],
  ['HUILA', 'HUI'], ['META', 'MET'], ['OPERACION NACIONAL', 'OPN'], ['PARQUE CONMEMORATIVO TRASCENDER', 'PCT'],
  ['PUTUMAYO', 'PUT'], ['QUINDIO', 'QUI'], ['RISARALDA', 'RIS'], ['SANTANDER', 'SAN'], ['TOLIMA NORTE', 'TON'],
  ['CUNDINAMARCA', 'CUN'], ['VALLE CENTRO', 'VCE'], ['VALLE CENTRO-PALMIRA', 'VCP'], ['VALLE NORTE', 'VNO'], ['VALLE SUR', 'VSU']
];
const SEDES = [
  ['Medellín', 'Bello'], ['Barranquilla', 'Soledad'], ['Bogotá Norte', 'Bogotá Sur'], ['Manizales', 'Villamaría'],
  ['Popayán', 'Santander de Quilichao'], ['Neiva', 'Pitalito'], ['Villavicencio', 'Granada'],
  ['Oficina Nacional', 'Centro de Soporte'], ['Parque Conmemorativo', 'Administración Parque'], ['Mocoa', 'Puerto Asís'],
  ['Armenia', 'Calarcá'], ['Pereira', 'Dosquebradas'], ['Bucaramanga', 'Floridablanca'], ['Ibagué', 'Mariquita'],
  ['Soacha', 'Zipaquirá'], ['Tuluá', 'Buga'], ['Palmira', 'Pradera'], ['Cartago', 'Zarzal'], ['Cali Sur', 'Jamundí']
];
const CATEGORIAS = [
  ['Computador portátil', 'CLP', ['Lenovo', 'HP', 'Dell'], ['ThinkPad E14', 'ProBook 440', 'Latitude 3420']],
  ['Computador de escritorio', 'CPU', ['Dell', 'HP', 'Lenovo'], ['OptiPlex 3080', 'ProDesk 400', 'ThinkCentre M70']],
  ['Monitor', 'MON', ['LG', 'Samsung', 'Dell'], ['24MK430', 'S24F350', 'P2422H']],
  ['Impresora', 'IMP', ['Epson', 'HP', 'Brother'], ['L3250', 'LaserJet M404', 'HL-L2370']],
  ['Teléfono IP', 'TEL', ['Yealink', 'Grandstream', 'Cisco'], ['T31P', 'GRP2602', 'CP-7821']],
  ['Equipo de red', 'NET', ['Ubiquiti', 'TP-Link', 'Cisco'], ['UniFi AP', 'TL-SG1024', 'SG350']],
  ['Mobiliario de oficina', 'MOB', ['Rimax', 'Ofiplan', 'Muebles JR'], ['Escritorio', 'Silla ergonómica', 'Archivador']],
  ['Tablet / Móvil', 'TAB', ['Samsung', 'Apple', 'Lenovo'], ['Tab A8', 'iPad 9', 'Tab M10']]
];
const NOMBRES = ['Carlos', 'María', 'Juan', 'Luisa', 'Andrés', 'Paola', 'Jorge', 'Diana', 'Felipe', 'Sandra', 'Camilo', 'Natalia', 'Julián', 'Laura', 'Sergio'];
const APELLIDOS = ['Gómez', 'Rodríguez', 'Martínez', 'López', 'García', 'Hernández', 'Ramírez', 'Torres', 'Díaz', 'Vargas', 'Castro', 'Ospina', 'Cardona', 'Giraldo', 'Zapata'];
const CARGOS = ['Auxiliar administrativo', 'Asesor comercial', 'Coordinador de sede', 'Contador', 'Analista de soporte', 'Recepcionista'];

const CHECKLIST = [
  'El activo existe físicamente en la ubicación registrada.',
  'El código de inventario coincide con el sistema.',
  'La etiqueta de identificación (QR) está pegada y legible.',
  'El número de serie físico coincide con el registrado.',
  'La marca y el modelo coinciden con el registro.',
  'El responsable asignado es el custodio actual.',
  'El responsable es un colaborador activo (no retirado).',
  'La regional y la sede registradas son correctas.',
  'La ubicación específica está actualizada.',
  'El estado físico registrado corresponde a la inspección.',
  'El estado operativo registrado corresponde al funcionamiento.',
  'El activo enciende o funciona correctamente (si aplica).',
  'No presenta daños visibles que afecten su uso.',
  'Cuenta con fotografía de evidencia actualizada.',
  'No está duplicado en el inventario maestro.',
  'Los traslados recientes están registrados con su motivo.',
  'Los accesorios y componentes principales están completos.',
  'El mantenimiento preventivo está al día (si aplica).'
].map((pregunta, i) => ({ id: i + 1, orden: i + 1, pregunta }));

function buildSeed() {
  const r = rng(20261123);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const now = nowCO();
  const today = todayCO();

  const db = {
    roles: [{ id: 1, nombre: 'ADMINISTRADOR' }, { id: 2, nombre: 'COORDINADOR' }, { id: 3, nombre: 'CALIDAD / AUDITOR' }],
    usuarios: [
      { id: 1, nombre_completo: 'Administrador General', email: 'admin@jardinesdelrenacer.com', cargo: 'Administrador del sistema', rol_id: 1, regionales: [], pass: hashPassword('admin123'), activo: true },
      { id: 2, nombre_completo: 'Coordinador Risaralda', email: 'coordinador.risaralda@jardinesdelrenacer.com', cargo: 'Coordinador de Regional', rol_id: 2, regionales: [12], pass: hashPassword('coord123'), activo: true },
      { id: 3, nombre_completo: 'Auditor de Calidad', email: 'calidad@jardinesdelrenacer.com', cargo: 'Auditor de Calidad', rol_id: 3, regionales: [], pass: hashPassword('calidad123'), activo: true }
    ],
    regionales: REGIONALES.map(([nombre, codigo], i) => ({ id: i + 1, nombre, codigo })),
    sedes: [],
    categorias: CATEGORIAS.map((c, i) => ({ id: i + 1, nombre: c[0] })),
    colaboradores: [], activos: [], movimientos: [], fotografias: [], novedades: [], mantenimientos: [],
    notificaciones: [], jornadas: [], conversaciones: [], mensajes: [], checklist: CHECKLIST,
    auditorias: [], hallazgos: [], errores: []
  };

  SEDES.forEach((pair, ri) => pair.forEach((ciudad, k) =>
    db.sedes.push({ id: db.sedes.length + 1, regional_id: ri + 1, nombre: `Sede ${ciudad}`, ciudad })));

  // Colaboradores (3 por regional); algunos retirados
  const retirados = [34, 47];
  for (let ri = 1; ri <= 19; ri++) {
    const sedesR = db.sedes.filter((s) => s.regional_id === ri);
    for (let k = 0; k < 3; k++) {
      const id = db.colaboradores.length + 1;
      const ret = retirados.includes(id);
      db.colaboradores.push({
        id, documento: String(1000000000 + id * 7919), nombre_completo: `${pick(NOMBRES)} ${pick(APELLIDOS)} ${pick(APELLIDOS)}`,
        cargo: pick(CARGOS), regional_id: ri, sede_id: sedesR[k % sedesR.length].id,
        estado_vinculacion: ret ? 'RETIRADO' : 'ACTIVO', fecha_ingreso: addDays(today, -400 - id * 3),
        fecha_retiro: ret ? addDays(today, -10 - id) : null
      });
    }
  }

  // Activos
  const estFis = ['BUENO', 'BUENO', 'BUENO', 'BUENO', 'REGULAR', 'REGULAR', 'MALO', 'DAÑADO'];
  for (let i = 1; i <= 260; i++) {
    const ri = i % 5 === 0 ? 12 : 1 + Math.floor(r() * 19);
    const sedesR = db.sedes.filter((s) => s.regional_id === ri);
    const ci = Math.floor(r() * CATEGORIAS.length);
    const cat = CATEGORIAS[ci];
    const sinReg = r() < 0.02;
    const fis = pick(estFis);
    const colabsR = db.colaboradores.filter((c) => c.regional_id === ri);
    const asignado = !sinReg && r() < 0.72;
    const a = {
      id: uuid(i), id_origen: i,
      codigo_inventario: r() < 0.06 ? null : `${cat[1]} ${pad(i, 4)}`,
      numero_serie: r() < 0.08 ? null : (crypto.createHash('md5').update('s' + i).digest('hex').slice(0, 12).toUpperCase()),
      nombre: `${cat[0]} ${pick(cat[2])} ${pick(cat[3])}`,
      categoria_id: ci + 1, marca: pick(cat[2]), modelo: pick(cat[3]),
      regional_id: sinReg ? null : ri, sede_id: sinReg ? null : pick(sedesR).id,
      ubicacion_especifica: pick(['Recepción', 'Administración', 'Sala de ventas', 'Bodega', 'Oficina gerencia', 'Archivo']),
      responsable_id: asignado ? pick(colabsR).id : null,
      estado_fisico: fis,
      estado_operativo: fis === 'DAÑADO' ? 'FUERA DE SERVICIO' : pick(['OPERATIVO', 'OPERATIVO', 'OPERATIVO', 'EN MANTENIMIENTO', 'EN BODEGA']),
      estado_registro: r() < 0.05 ? 'NUEVO - PENDIENTE DE VALIDACIÓN' : 'VALIDADO',
      observaciones: '', verificado_en: null, created_at: now, updated_at: now
    };
    db.activos.push(a);
    if (a.responsable_id) {
      db.movimientos.push({
        id: db.movimientos.length + 1, activo_id: a.id, fecha: addDays(today, -60) + 'T09:00:00', tipo_movimiento: 'ASIGNACION',
        motivo: 'Asignación inicial de custodia', resp_ant_id: null, resp_nvo_id: a.responsable_id,
        ubicacion_anterior: null, ubicacion_nueva: a.ubicacion_especifica, usuario_id: 1
      });
    }
  }
  // Garantizar al menos 3 activos en manos de colaboradores retirados
  const retColab = db.colaboradores.find((c) => c.estado_vinculacion === 'RETIRADO');
  db.activos.filter((a) => a.regional_id === retColab.regional_id).slice(0, 3).forEach((a) => { a.responsable_id = retColab.id; });

  // Fotografías de ejemplo (SVG embebido, sin red)
  db.activos.slice(0, 8).forEach((a) => {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='160'><rect width='240' height='160' fill='#ede9fe'/><text x='120' y='85' font-size='16' text-anchor='middle' fill='#5b21b6' font-family='Arial'>${a.codigo_inventario || 'SIN CODIGO'}</text></svg>`;
    db.fotografias.push({ activo_id: a.id, url_o_base64: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), tipo_foto: 'Frontal' });
  });

  // Mantenimientos
  db.activos.filter((a) => a.estado_operativo === 'EN MANTENIMIENTO').slice(0, 6).forEach((a, k) => {
    db.mantenimientos.push({
      id: k + 1, activo_id: a.id, fecha_solicitud: addDays(today, -5 - k), tipo_mantenimiento: k % 2 ? 'CORRECTIVO' : 'PREVENTIVO',
      diagnostico: k % 2 ? 'Falla en fuente de poder' : 'Limpieza y revisión general', responsable_servicio: 'Soporte TIC',
      costo: 45000 + k * 15000, estado: 'EN PROCESO'
    });
  });

  // Jornadas
  const ids = (ri, n) => db.activos.filter((a) => a.regional_id === ri).slice(0, n).map((a) => a.id);
  const sedeDe = (ri) => db.sedes.find((s) => s.regional_id === ri).id;
  db.jornadas.push(
    { id: 1, titulo: 'Verificación Física Regional Risaralda', tipo_actividad: 'Verificación física', regional_id: 12, sedes_ids: [], fecha_inicio: addDays(today, -3), fecha_fin: addDays(today, 10), hora_inicio: '08:00', hora_fin: '17:00', coordinador_id: 2, meta_verificacion: 20, verificados: ids(12, 8), historial: [], finalizada: false },
    { id: 2, titulo: 'Levantamiento Inicial Antioquia', tipo_actividad: 'Levantamiento inicial', regional_id: 1, sedes_ids: [sedeDe(1)], fecha_inicio: addDays(today, 7), fecha_fin: addDays(today, 14), hora_inicio: '08:00', hora_fin: '17:00', coordinador_id: 1, meta_verificacion: 30, verificados: [], historial: [], finalizada: false },
    { id: 3, titulo: 'Conciliación Atlántico', tipo_actividad: 'Conciliación de inventario', regional_id: 2, sedes_ids: [], fecha_inicio: addDays(today, -20), fecha_fin: addDays(today, -10), hora_inicio: '08:00', hora_fin: '17:00', coordinador_id: 1, meta_verificacion: 10, verificados: ids(2, 10), historial: [], finalizada: false }
  );

  // Chat
  db.conversaciones.push(
    { id: 1, titulo: 'Canal Nacional - Coordinación General', regional_id: null },
    { id: 2, titulo: 'Calidad y Auditoría', regional_id: null },
    { id: 3, titulo: 'Jornada: Verificación Física Regional Risaralda', regional_id: 12 }
  );
  db.mensajes.push(
    { id: 1, conversacion_id: 1, remitente_id: 1, texto: 'Bienvenidos al canal institucional de activos.', activo_id: null, created_at: now },
    { id: 2, conversacion_id: 3, remitente_id: 2, texto: 'Iniciamos la verificación física en Risaralda.', activo_id: null, created_at: now }
  );

  // Auditoría programada + hallazgo de ejemplo
  const sedeRis = db.sedes.find((s) => s.regional_id === 12);
  const detalle = db.activos.filter((a) => a.sede_id === sedeRis.id).slice(0, 8).map((a) => a.id);
  db.auditorias.push({
    id: 1, codigo: `AUD-${today.slice(0, 4)}-0001`, titulo: 'Auditoría de Calidad Sede Pereira', regional_id: 12, sede_id: sedeRis.id,
    tipo_alcance: 'SEDE_COMPLETA', fecha_programada: addDays(today, 3), auditor_id: 3, estado: 'PROGRAMADA', resultado_final: null,
    detalle_ids: detalle, evaluaciones: {}
  });
  const hz = db.activos.find((a) => a.regional_id === 12);
  db.hallazgos.push({
    id: 1, codigo: `HAL-${today.slice(0, 4)}-0001`, auditoria_id: null, activo_id: hz.id, regional_id: 12, sede_id: hz.sede_id,
    descripcion: 'Activo sin etiqueta de identificación visible', criticidad: 'ALTA', fecha_compromiso: addDays(today, 12),
    estado: 'ABIERTO', accion_realizada: '', evidencia_correccion: '', historial: []
  });

  // Novedades y notificaciones iniciales
  db.novedades.push({ id: 1, activo_id: hz.id, fecha: now, campo_modificado: 'ubicacion_especifica', valor_anterior: 'Bodega', valor_nuevo: hz.ubicacion_especifica, justificacion: 'Conciliación inicial', estado: 'REGISTRADA', regional_id: 12 });
  db.notificaciones.push(
    { id: 1, usuario_id: null, roles: null, regional_id: null, titulo: 'Sistema listo', mensaje: 'El Sistema Integral de Activos está operativo.', created_at: now, leida_por: [], link: null },
    { id: 2, usuario_id: null, roles: null, regional_id: 12, titulo: 'Jornada en ejecución', mensaje: 'Verificación Física Regional Risaralda en curso.', created_at: now, leida_por: [], link: null }
  );
  return db;
}

module.exports = { buildSeed };
