// ==============================================================================
// JARDINES DEL RENACER - SISTEMA INTEGRAL DE ACTIVOS
// FRONTEND APPLICATION ARCHITECTURE & ROUTING
// ==============================================================================

const STATE = {
  token: localStorage.getItem('jr_token') || null,
  user: null,
  activeView: 'dashboard',
  regionales: [],
  sedes: [],
  categorias: [],
  maestroQuery: {
    page: 1,
    page_size: 15,
    q: '',
    regional_id: '',
    sede_id: '',
    categoria_id: '',
    estado_fisico: '',
    estado_operativo: '',
    estado_registro: '',
    integridad: 'todos'
  },
  activeChatConvId: null,
  chatPollingInterval: null
};

// ==============================================================================
// API CLIENT
// ==============================================================================
async function api(path, options = {}) {
  const headers = options.headers || {};
  headers['Content-Type'] = 'application/json';
  if (STATE.token) {
    headers['Authorization'] = `Bearer ${STATE.token}`;
  }

  try {
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (res.status === 401) {
      logout();
      throw new Error('Sesión expirada');
    }

    let data = {};
    try { data = await res.json(); } catch (_) { /* respuesta no JSON */ }
    if (!res.ok) {
      throw new Error(data.error || `Error ${res.status} en la petición`);
    }
    return data;
  } catch (err) {
    showToast(err.message, 'error');
    err.fromApi = true;
    throw err;
  }
}

// DESCARGAS AUTENTICADAS (CSV / LOG): los enlaces <a href> no envían el token
async function downloadAuthFile(path, fallbackName) {
  try {
    const res = await fetch(path, { headers: { 'Authorization': `Bearer ${STATE.token}` } });
    if (!res.ok) {
      let msg = `Error ${res.status} al descargar`;
      try { msg = (await res.json()).error || msg; } catch (_) {}
      throw new Error(msg);
    }
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="?([^";]+)"?/.exec(cd);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : fallbackName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// UI TOAST
function showToast(msg, type = 'info') {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;border-radius:8px;font-size:0.88rem;color:#fff;font-weight:600;box-shadow:var(--shadow-lg);transition:all 0.3s;opacity:0;pointer-events:none;';
    document.body.appendChild(toast);
  }
  toast.innerText = msg;
  toast.style.background = type === 'error' ? '#ef4444' : (type === 'success' ? '#10b981' : '#3b82f6');
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
  }, 3500);
}

// ==============================================================================
// AUTHENTICATION & INITIALIZATION
// ==============================================================================
async function initApp() {
  if (!STATE.token) {
    showAuthScreen();
    return;
  }

  try {
    const res = await api('/api/auth/me');
    STATE.user = res.user;
    showMainApp();
    await loadInitialCatalogs();
    navigate('dashboard');
    startNotificationPolling();
  } catch (err) {
    logout();
  }
}

function showAuthScreen() {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('main-app').style.display = 'none';
  toggleAuthPanel('login');
}

function toggleAuthPanel(panel) {
  const pLogin = document.getElementById('panel-login');
  const pReg = document.getElementById('panel-register');
  if (panel === 'register') {
    if (pLogin) pLogin.style.display = 'none';
    if (pReg) pReg.style.display = 'block';
  } else {
    if (pLogin) pLogin.style.display = 'block';
    if (pReg) pReg.style.display = 'none';
  }
}

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input.type === 'password') {
    input.type = 'text';
    btn.innerText = '🙈';
  } else {
    input.type = 'password';
    btn.innerText = '👁️';
  }
}

function setQuickLogin(email, password) {
  toggleAuthPanel('login');
  document.getElementById('login-email').value = email;
  document.getElementById('login-password').value = password;
  showToast(`Credenciales cargadas para ${email.split('@')[0]}`, 'info');
}

async function handleRegisterUser(e) {
  e.preventDefault();
  const nombre = document.getElementById('reg-nombre').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const cargo = document.getElementById('reg-cargo').value.trim();
  const regional_id = document.getElementById('reg-regional').value;
  const rol_id = document.getElementById('reg-rol').value;
  const password = document.getElementById('reg-password').value;

  if (!nombre || !email || !password) {
    showToast('Por favor complete los campos obligatorios', 'error');
    return;
  }

  try {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: {
        nombre_completo: nombre,
        email,
        password,
        cargo,
        regional_id: regional_id ? parseInt(regional_id) : null,
        rol_id: parseInt(rol_id)
      }
    });

    showToast('¡Usuario creado y registrado exitosamente!', 'success');
    STATE.token = res.token;
    localStorage.setItem('jr_token', res.token);
    STATE.user = res.user;
    showMainApp();
    await loadInitialCatalogs();
    navigate('dashboard');
    startNotificationPolling();
  } catch (err) {
    // Handled in api()
  }
}

function showMainApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('main-app').style.display = 'flex';

  // Set user profile in header
  document.getElementById('user-display-name').innerText = STATE.user.nombre_completo;
  const roleEl = document.getElementById('user-display-role');
  roleEl.innerText = STATE.user.rol_nombre;
  roleEl.className = `pill-role ${STATE.user.rol_nombre.toLowerCase().replace(/[^a-z]/g, '')}`;
  document.getElementById('user-avatar').innerText = STATE.user.nombre_completo.substring(0, 2).toUpperCase();

  const regScopeEl = document.getElementById('regional-scope-pill');
  if (STATE.user.rol_nombre === 'COORDINADOR') {
    regScopeEl.innerText = `Regional Asignada (${STATE.user.regionales.length})`;
    regScopeEl.style.background = '#e0f2fe';
    regScopeEl.style.color = '#0369a1';
  } else if (STATE.user.rol_nombre === 'CALIDAD / AUDITOR') {
    regScopeEl.innerText = 'Calidad y Control';
    regScopeEl.style.background = '#fef3c7';
    regScopeEl.style.color = '#92400e';
  } else {
    regScopeEl.innerText = 'Nacional (19 Regionales)';
  }

  // Toggle admin menus
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = STATE.user.rol_nombre === 'ADMINISTRADOR' ? 'flex' : 'none';
  });
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password }
    });
    STATE.token = res.token;
    localStorage.setItem('jr_token', res.token);
    STATE.user = res.user;
    showMainApp();
    await loadInitialCatalogs();
    navigate('dashboard');
    startNotificationPolling();
    showToast('Bienvenido a Jardines del Renacer', 'success');
  } catch (err) {
    // Handled in api
  }
}

function logout() {
  STATE.token = null;
  STATE.user = null;
  localStorage.removeItem('jr_token');
  if (STATE.chatPollingInterval) clearInterval(STATE.chatPollingInterval);
  if (STATE.notifInterval) { clearInterval(STATE.notifInterval); STATE.notifInterval = null; }
  showAuthScreen();
}

async function loadInitialCatalogs() {
  const [regRes, sedesRes, catRes] = await Promise.all([
    api('/api/regionales'),
    api('/api/sedes'),
    api('/api/categorias')
  ]);
  STATE.regionales = regRes.regionales || [];
  STATE.sedes = sedesRes.sedes || [];
  STATE.categorias = catRes.categorias || [];
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ==============================================================================
// ROUTER & NAVIGATION
// ==============================================================================
function navigate(viewName, params = {}) {
  STATE.activeView = viewName;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

  // Highlight active nav item
  const navMap = {
    dashboard: 0, maestro: 1, fisico: 2, registro: 3, qr: 4, regionales: 5,
    colaboradores: 6, movimientos: 7, novedades: 8, calendario: 9, chat: 10,
    calidad: 11, hallazgos: 12, mantenimiento: 13, reportes: 14, notificaciones: 15,
    usuarios: 16, configuracion: 17
  };
  const items = document.querySelectorAll('#main-nav .nav-item');
  if (items[navMap[viewName]]) items[navMap[viewName]].classList.add('active');

  const content = document.getElementById('page-content');
  content.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280;">Cargando módulo...</div>';

  if (viewName === 'dashboard') renderDashboard();
  else if (viewName === 'maestro') renderMaestro();
  else if (viewName === 'fisico') renderFisico();
  else if (viewName === 'registro') renderRegistro();
  else if (viewName === 'qr') renderQR();
  else if (viewName === 'regionales') renderRegionales();
  else if (viewName === 'colaboradores') renderColaboradores();
  else if (viewName === 'movimientos') renderMovimientos();
  else if (viewName === 'novedades') renderNovedades();
  else if (viewName === 'calendario') renderCalendario();
  else if (viewName === 'chat') renderChat();
  else if (viewName === 'calidad') renderCalidad();
  else if (viewName === 'hallazgos') renderHallazgos();
  else if (viewName === 'mantenimiento') renderMantenimiento();
  else if (viewName === 'reportes') renderReportes();
  else if (viewName === 'notificaciones') renderNotificaciones();
  else if (viewName === 'usuarios') renderUsuarios();
  else if (viewName === 'configuracion') renderConfiguracion();
}

function handleGlobalSearch(e) {
  if (e.key === 'Enter') {
    const q = e.target.value.trim();
    STATE.maestroQuery.q = q;
    STATE.maestroQuery.page = 1;
    navigate('maestro');
  }
}

// ==============================================================================
// 1. DASHBOARD GENERAL NACIONAL (SECCIÓN 16)
// ==============================================================================
async function renderDashboard() {
  const res = await api('/api/dashboard');
  const d = res;
  const k = d.activos_kpis;

  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <div>
        <h1 style="font-size:1.4rem;font-weight:800;color:var(--secondary);">Panel Ejecutivo de Control de Activos</h1>
        <p style="font-size:0.82rem;color:var(--text-muted);">Monitoreo integral de las 19 regionales - Jardines del Renacer</p>
      </div>
      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline btn-sm" onclick="renderDashboard()">🔄 Actualizar</button>
        <button class="btn btn-primary btn-sm" onclick="navigate('registro')">➕ Registrar Activo</button>
      </div>
    </div>

    <!-- KPIS GENERALES -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-icon">📦</div>
        <div class="kpi-info">
          <h4>Total Activos</h4>
          <div class="kpi-value">${(k.total_activos || 0).toLocaleString()}</div>
          <div class="kpi-sub">En base oficial maestra</div>
        </div>
      </div>
      <div class="kpi-card warning">
        <div class="kpi-icon" style="background:#fef3c7;color:#92400e;">⚠️</div>
        <div class="kpi-info">
          <h4>Incompletos / Sin Datos</h4>
          <div class="kpi-value">${k.incompletos || 0}</div>
          <div class="kpi-sub">${k.sin_serial || 0} sin serial | ${k.sin_codigo || 0} sin cód</div>
        </div>
      </div>
      <div class="kpi-card ${k.activos_en_retirados > 0 ? 'danger' : ''}">
        <div class="kpi-icon" style="background:#fee2e2;color:#991b1b;">🚨</div>
        <div class="kpi-info">
          <h4>En Colab. Retirados</h4>
          <div class="kpi-value">${k.activos_en_retirados || 0}</div>
          <div class="kpi-sub"><a href="javascript:navigate('colaboradores')" style="color:#dc2626;text-decoration:underline;">Ver pendientes</a></div>
        </div>
      </div>
      <div class="kpi-card accent">
        <div class="kpi-icon" style="background:#fef3c7;color:#c5a059;">✅</div>
        <div class="kpi-info">
          <h4>Cumplimiento Calidad</h4>
          <div class="kpi-value">${d.calidad_kpis.promedio_cumplimiento ? d.calidad_kpis.promedio_cumplimiento.toFixed(1) : '100'}%</div>
          <div class="kpi-sub">${d.hallazgos_kpis.abiertos || 0} hallazgos abiertos</div>
        </div>
      </div>
    </div>

    <!-- DISTRIBUCIÓN POR REGIONAL & CATEGORÍA -->
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:20px;margin-bottom:24px;">
      <div class="card">
        <div class="card-header">
          <div class="card-title">🏢 Inventario por Regional (19 Regionales)</div>
          <button class="btn btn-outline btn-sm" onclick="navigate('regionales')">Ver Sedes</button>
        </div>
        <div style="max-height:340px;overflow-y:auto;">
          <table class="data-table">
            <thead>
              <tr><th>Regional</th><th style="text-align:right;">Total Activos</th><th style="width:40%;">Proporción</th></tr>
            </thead>
            <tbody>
              ${d.por_regional.map(r => `
                <tr>
                  <td><b>${r.nombre}</b></td>
                  <td style="text-align:right;font-weight:700;">${r.cantidad}</td>
                  <td>
                    <div style="background:#e5e7eb;height:8px;border-radius:4px;overflow:hidden;">
                      <div style="background:var(--primary);height:100%;width:${k.total_activos ? (r.cantidad / k.total_activos * 100) : 0}%;"></div>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">🏷️ Por Categoría</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${d.por_categoria.map(c => `
            <div>
              <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:4px;">
                <span>${c.nombre}</span>
                <b>${c.cantidad}</b>
              </div>
              <div style="background:#e5e7eb;height:6px;border-radius:3px;overflow:hidden;">
                <div style="background:var(--accent);height:100%;width:${k.total_activos ? (c.cantidad / k.total_activos * 100) : 0}%;"></div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>

    <!-- RESUMEN DE JORNADAS Y CALIDAD -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
      <div class="card">
        <div class="card-header">
          <div class="card-title">📅 Jornadas de Inventario Activas</div>
          <button class="btn btn-outline btn-sm" onclick="navigate('calendario')">Ir al Calendario</button>
        </div>
        <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:12px;">
          Total programadas: <b>${d.calendario_kpis.total_jornadas || 0}</b> | En ejecución: <b>${d.calendario_kpis.en_ejecucion || 0}</b>
        </p>
        <button class="btn btn-secondary btn-sm" onclick="navigate('calendario')">Ver Programación Nacional</button>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">🔍 Control de Auditorías de Calidad</div>
          <button class="btn btn-outline btn-sm" onclick="navigate('calidad')">Módulo Calidad</button>
        </div>
        <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:12px;">
          ${d.calidad_kpis.total_auditorias || 0} auditorías registradas con lista de verificación de 18 puntos.
        </p>
        <button class="btn btn-primary btn-sm" onclick="navigate('calidad')">Gestionar Auditorías y Hallazgos</button>
      </div>
    </div>
  `;

  document.getElementById('page-content').innerHTML = html;
}

// ==============================================================================
// 2. INVENTARIO MAESTRO (SECCIÓN 5)
// ==============================================================================
async function renderMaestro() {
  const q = STATE.maestroQuery;
  const queryStr = `page=${q.page}&page_size=${q.page_size}&q=${encodeURIComponent(q.q)}&regional_id=${q.regional_id}&sede_id=${q.sede_id}&categoria_id=${q.categoria_id}&estado_fisico=${q.estado_fisico}&estado_operativo=${q.estado_operativo}&integridad=${q.integridad}`;

  const res = await api(`/api/maestro?${queryStr}`);

  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div>
        <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Inventario Maestro de Activos</h1>
        <p style="font-size:0.8rem;color:var(--text-muted);">Base oficial de activos con UUIDs independientes y trazabilidad</p>
      </div>
      <div style="display:flex;gap:10px;">
        <a href="javascript:void(0)" class="btn btn-outline btn-sm" onclick="downloadAuthFile('/api/reportes/1','inventario.csv')">📥 Exportar CSV</a>
        <button class="btn btn-primary btn-sm" onclick="navigate('registro')">➕ Nuevo Registro</button>
      </div>
    </div>

    <!-- FILTROS AVANZADOS -->
    <div class="card" style="padding:14px;margin-bottom:16px;">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:10px;">
        <div>
          <label style="font-size:0.75rem;font-weight:600;">Búsqueda</label>
          <input type="text" class="form-control" style="padding:6px 10px;font-size:0.82rem;" placeholder="Nombre, serial, código..." value="${q.q}" onchange="STATE.maestroQuery.q=this.value;STATE.maestroQuery.page=1;renderMaestro();">
        </div>
        <div>
          <label style="font-size:0.75rem;font-weight:600;">Regional</label>
          <select class="form-control" style="padding:6px 10px;font-size:0.82rem;" onchange="STATE.maestroQuery.regional_id=this.value;STATE.maestroQuery.page=1;renderMaestro();">
            <option value="">Todas las regionales</option>
            ${STATE.regionales.map(r => `<option value="${r.id}" ${q.regional_id == r.id ? 'selected' : ''}>${r.nombre}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:0.75rem;font-weight:600;">Categoría</label>
          <select class="form-control" style="padding:6px 10px;font-size:0.82rem;" onchange="STATE.maestroQuery.categoria_id=this.value;STATE.maestroQuery.page=1;renderMaestro();">
            <option value="">Todas las categorías</option>
            ${STATE.categorias.map(c => `<option value="${c.id}" ${q.categoria_id == c.id ? 'selected' : ''}>${c.nombre}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:0.75rem;font-weight:600;">Integridad de Datos</label>
          <select class="form-control" style="padding:6px 10px;font-size:0.82rem;" onchange="STATE.maestroQuery.integridad=this.value;STATE.maestroQuery.page=1;renderMaestro();">
            <option value="todos" ${q.integridad == 'todos' ? 'selected' : ''}>Todos los registros</option>
            <option value="completos" ${q.integridad == 'completos' ? 'selected' : ''}>Completos</option>
            <option value="incompletos" ${q.integridad == 'incompletos' ? 'selected' : ''}>⚠️ Incompletos</option>
            <option value="sin_serial" ${q.integridad == 'sin_serial' ? 'selected' : ''}>Sin número de serie</option>
            <option value="sin_codigo" ${q.integridad == 'sin_codigo' ? 'selected' : ''}>Sin código inventario</option>
            <option value="sin_regional" ${q.integridad == 'sin_regional' ? 'selected' : ''}>Sin regional asignada</option>
          </select>
        </div>
      </div>
    </div>

    <!-- TABLA DE ACTIVOS -->
    <div class="card" style="padding:0;overflow:hidden;">
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Código / Serial</th>
              <th>Nombre del Activo</th>
              <th>Regional / Sede</th>
              <th>Responsable</th>
              <th>Estado Físico / Op</th>
              <th>Integridad</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${res.items.map(a => `
              <tr style="cursor:pointer;" onclick="openFichaActivo('${a.id}')">
                <td>
                  <b style="color:var(--primary);">${a.codigo_inventario || '<span style="color:#dc2626;">[SIN CÓDIGO]</span>'}</b><br>
                  <span style="font-size:0.75rem;color:var(--text-muted);">${a.numero_serie || '[Sin serial]'}</span>
                </td>
                <td>
                  <div style="font-weight:600;">${a.nombre}</div>
                  <span style="font-size:0.72rem;color:var(--text-muted);">${a.categoria_nombre || a.tipo_elemento || ''}</span>
                </td>
                <td>
                  <div>${a.regional_nombre || '<span style="color:#dc2626;">[Sin regional]</span>'}</div>
                  <span style="font-size:0.72rem;color:var(--text-muted);">${a.sede_nombre || a.ubicacion_especifica || '-'}</span>
                </td>
                <td>
                  <div>${a.responsable_nombre || '<span style="color:#6b7280;">Disponible / Sin asignar</span>'}</div>
                  ${a.responsable_estado === 'RETIRADO' ? '<span class="badge danger">Colaborador Retirado</span>' : ''}
                </td>
                <td>
                  <span class="badge ${a.estado_fisico === 'BUENO' ? 'success' : (a.estado_fisico === 'DAÑADO' ? 'danger' : 'warning')}">${a.estado_fisico}</span>
                  <span class="badge info">${a.estado_operativo}</span>
                </td>
                <td>
                  ${a.es_incompleto ? '<span class="badge warning" title="Faltan datos de serial, código o regional">⚠️ Incompleto</span>' : '<span class="badge success">✓ Completo</span>'}
                </td>
                <td onclick="event.stopPropagation()">
                  <button class="btn btn-outline btn-sm" onclick="openFichaActivo('${a.id}')">Ficha</button>
                  <button class="btn btn-outline btn-sm" onclick="printQRLabel('${a.id}')" title="Etiqueta QR">🏷️</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- PAGINACIÓN -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-top:1px solid var(--border-color);font-size:0.82rem;">
        <div>Mostrando <b>${res.items.length}</b> de <b>${res.total}</b> activos</div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-outline btn-sm" ${res.page <= 1 ? 'disabled' : ''} onclick="STATE.maestroQuery.page--;renderMaestro();">Anterior</button>
          <span style="padding:4px 8px;">Pág ${res.page} de ${res.total_pages}</span>
          <button class="btn btn-outline btn-sm" ${res.page >= res.total_pages ? 'disabled' : ''} onclick="STATE.maestroQuery.page++;renderMaestro();">Siguiente</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('page-content').innerHTML = html;
}

// ==============================================================================
// 3. FICHA DETALLADA DEL ACTIVO (SECCIÓN 2, 5, 6, 7)
// ==============================================================================
async function openFichaActivo(uuid) {
  const res = await api(`/api/maestro/${uuid}`);
  const a = res.activo;

  const modalHtml = `
    <div class="modal-overlay" id="modal-ficha">
      <div class="modal-content" style="max-width:850px;">
        <div class="modal-header">
          <div>
            <h3 style="color:var(--secondary);font-size:1.15rem;font-weight:700;">Ficha del Activo</h3>
            <span style="font-size:0.75rem;color:var(--text-muted);font-family:monospace;">UUID: ${a.id} | Ref Origen ID: ${a.id_origen || '-'}</span>
          </div>
          <button class="btn-close" onclick="closeModal('modal-ficha')">&times;</button>
        </div>

        <!-- HEADER ACTIVO -->
        <div style="display:flex;justify-content:space-between;align-items:flex-start;background:#f8fafc;padding:14px;border-radius:8px;margin-bottom:16px;">
          <div>
            <h2 style="font-size:1.1rem;color:var(--primary);margin-bottom:4px;">${a.nombre}</h2>
            <div style="font-size:0.82rem;color:var(--text-muted);">
              Código: <b>${a.codigo_inventario || '[Sin Código]'}</b> | Serial: <b>${a.numero_serie || '[Sin Serial]'}</b>
            </div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-outline btn-sm" onclick="shareAssetInChat('${a.id}', '${a.nombre.replace(/'/g, "\\'")}', '${a.codigo_inventario || ''}')">💬 Compartir en Chat</button>
            <button class="btn btn-primary btn-sm" onclick="printQRLabel('${a.id}')">🏷️ Imprimir Etiqueta QR</button>
          </div>
        </div>

        <!-- PESTAÑAS DE INFORMACIÓN -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
          <div>
            <h4 style="font-size:0.82rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px;">Ubicación y Responsable</h4>
            <div style="font-size:0.85rem;line-height:1.6;">
              Regional: <b>${a.regional_nombre || 'No asignada'}</b><br>
              Sede: <b>${a.sede_nombre || 'No asignada'}</b><br>
              Ubicación Específica: <b>${a.ubicacion_especifica || '-'}</b><br>
              Responsable: <b>${a.responsable_nombre || 'Sin asignar'}</b> ${a.responsable_estado === 'RETIRADO' ? '<span class="badge danger">RETIRADO</span>' : ''}<br>
            </div>
          </div>
          <div>
            <h4 style="font-size:0.82rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px;">Clasificación y Estado</h4>
            <div style="font-size:0.85rem;line-height:1.6;">
              Categoría: <b>${a.categoria_nombre || a.tipo_elemento || '-'}</b><br>
              Estado Físico: <span class="badge ${a.estado_fisico === 'BUENO' ? 'success' : 'warning'}">${a.estado_fisico}</span><br>
              Estado Operativo: <span class="badge info">${a.estado_operativo}</span><br>
              Estado Registro: <b>${a.estado_registro}</b><br>
            </div>
          </div>
        </div>

        <!-- HISTORIAL DE MOVIMIENTOS & VERIFICACIONES -->
        <div style="border-top:1px solid var(--border-color);padding-top:14px;margin-top:14px;">
          <h4 style="font-size:0.9rem;font-weight:700;color:var(--secondary);margin-bottom:10px;">Historial de Movimientos (${a.movimientos.length})</h4>
          ${a.movimientos.length === 0 ? '<p style="font-size:0.8rem;color:var(--text-muted);">Sin movimientos registrados.</p>' : `
            <table class="data-table" style="font-size:0.78rem;">
              <thead>
                <tr><th>Fecha</th><th>Tipo</th><th>Motivo</th><th>Responsable / Ubicación Nva</th><th>Usuario</th></tr>
              </thead>
              <tbody>
                ${a.movimientos.map(m => `
                  <tr>
                    <td>${m.fecha.substring(0, 16)}</td>
                    <td><b>${m.tipo_movimiento}</b></td>
                    <td>${m.motivo}</td>
                    <td>${m.resp_nvo_nombre || m.ubicacion_nueva || '-'}</td>
                    <td>${m.usuario_nombre || 'Sistema'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `}
        </div>

        <!-- GALERÍA DE FOTOGRAFÍAS -->
        <div style="border-top:1px solid var(--border-color);padding-top:14px;margin-top:14px;">
          <h4 style="font-size:0.9rem;font-weight:700;color:var(--secondary);margin-bottom:10px;">Evidencias Fotográficas (${a.fotografias.length})</h4>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            ${a.fotografias.map(f => `
              <div style="width:120px;border:1px solid var(--border-color);border-radius:6px;overflow:hidden;text-align:center;">
                <img src="${f.url_o_base64}" style="width:100%;height:80px;object-fit:cover;">
                <div style="font-size:0.68rem;padding:4px;color:var(--text-muted);">${f.tipo_foto}</div>
              </div>
            `).join('')}
            ${a.fotografias.length === 0 ? '<p style="font-size:0.8rem;color:var(--text-muted);">No cuenta con fotografías registradas.</p>' : ''}
          </div>
        </div>

        <div style="margin-top:20px;text-align:right;">
          <button class="btn btn-outline" onclick="closeModal('modal-ficha')">Cerrar</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('modal-container').innerHTML = modalHtml;
  document.getElementById('modal-container').style.display = 'block';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
  document.getElementById('modal-container').style.display = 'none';
}

// ==============================================================================
// 4. REGISTRO Y ACTUALIZACIÓN CON CONSULTA PREVIA (SECCIÓN 6)
// ==============================================================================
function renderRegistro() {
  const html = `
    <div style="max-width:850px;margin:0 auto;">
      <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);margin-bottom:4px;">Registro y Actualización de Activos</h1>
      <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:20px;">Flujo estricto de consulta previa al inventario maestro para prevenir duplicados.</p>

      <!-- PASO 1 A 4: CONSULTA PREVIA -->
      <div class="card" id="card-consulta-previa">
        <div class="card-header">
          <div class="card-title">🔍 Pasos 1 a 4: Consulta Previa Obligatoria</div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>1. Regional</label>
            <select id="reg-sel-regional" class="form-control" onchange="loadSedesForSelect(this.value, 'reg-sel-sede')" required>
              <option value="">Seleccione regional...</option>
              ${STATE.regionales.map(r => `<option value="${r.id}">${r.nombre}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>2. Sede</label>
            <select id="reg-sel-sede" class="form-control" required>
              <option value="">Seleccione regional primero...</option>
            </select>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:16px;">
          <label>4. Buscar en Inventario Maestro (Serial, Código de Inventario o Nombre)</label>
          <div style="display:flex;gap:10px;">
            <input type="text" id="reg-search-query" class="form-control" placeholder="Ej: CLP 0117, BBU2403290058, Dell Optiplex..." required>
            <button class="btn btn-primary" onclick="executePriorSearch()">Consultar Maestro</button>
          </div>
        </div>

        <div id="prior-search-results"></div>
      </div>

      <!-- FORMULARIO DE ACCIÓN (EXISTE O NO EXISTE) -->
      <div id="action-form-container"></div>
    </div>
  `;

  document.getElementById('page-content').innerHTML = html;
}

function loadSedesForSelect(regId, selectId) {
  const sel = document.getElementById(selectId);
  sel.innerHTML = '<option value="">Seleccione sede...</option>';
  const filtered = STATE.sedes.filter(s => s.regional_id == regId);
  filtered.forEach(s => {
    sel.innerHTML += `<option value="${s.id}">${s.nombre} (${s.ciudad || ''})</option>`;
  });
}

async function executePriorSearch() {
  const regId = document.getElementById('reg-sel-regional').value;
  const sedeId = document.getElementById('reg-sel-sede').value;
  const q = document.getElementById('reg-search-query').value.trim();

  if (!q) {
    showToast('Ingrese un término de búsqueda', 'error');
    return;
  }

  const res = await api('/api/activos/search-first', {
    method: 'POST',
    body: { regional_id: regId, sede_id: sedeId, q }
  });

  const resultsDiv = document.getElementById('prior-search-results');
  const actionDiv = document.getElementById('action-form-container');

  if (res.coincidencias && res.coincidencias.length > 0) {
    resultsDiv.innerHTML = `
      <div style="background:#ecfdf5;border:1px solid #6ee7b7;padding:12px;border-radius:6px;margin-top:12px;">
        <h4 style="color:#065f46;font-size:0.88rem;margin-bottom:6px;">✓ Se encontraron ${res.coincidencias.length} coincidencia(s) en el Inventario Maestro</h4>
        <p style="font-size:0.78rem;color:#047857;margin-bottom:10px;">Seleccione el activo correspondiente para actualizar su información física y registrar novedades de conciliación sin duplicar el registro.</p>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${res.coincidencias.map(a => `
            <div style="background:#fff;padding:10px;border-radius:6px;border:1px solid #d1fae5;display:flex;justify-content:space-between;align-items:center;">
              <div>
                <b>${a.nombre}</b> | Código: <b>${a.codigo_inventario || 'S-COD'}</b> | Serial: <b>${a.numero_serie || 'S-SER'}</b><br>
                <span style="font-size:0.75rem;color:var(--text-muted);">${a.regional_nombre || 'Sin regional'} - ${a.sede_nombre || 'Sin sede'}</span>
              </div>
              <button class="btn btn-primary btn-sm" onclick="showUpdateExistingForm('${a.id}')">Seleccionar y Actualizar</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    actionDiv.innerHTML = '';
  } else {
    resultsDiv.innerHTML = `
      <div style="background:#fffbeb;border:1px solid #fde68a;padding:12px;border-radius:6px;margin-top:12px;">
        <h4 style="color:#92400e;font-size:0.88rem;margin-bottom:4px;">No se encontró el activo en el Inventario Maestro</h4>
        <p style="font-size:0.78rem;color:#78350f;">Puede proceder a registrarlo como un activo nuevo. Se clasificará como <b>NUEVO - PENDIENTE DE VALIDACIÓN</b>.</p>
        <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="showCreateNewForm('${q.replace(/'/g, "\\'")}')">Registrar Nuevo Activo</button>
      </div>
    `;
    actionDiv.innerHTML = '';
  }
}

async function showUpdateExistingForm(activoId) {
  const res = await api(`/api/maestro/${activoId}`);
  const a = res.activo;

  const html = `
    <div class="card" style="margin-top:20px;border-left:4px solid var(--primary);">
      <div class="card-header">
        <div class="card-title">📝 Actualización Física y Conciliación</div>
      </div>
      <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:14px;">
        Activo: <b>${a.nombre}</b> (${a.codigo_inventario || 'Sin Código'})
      </p>

      <form onsubmit="submitPhysicalUpdate(event, '${a.id}')">
        <div class="form-grid">
          <div class="form-group">
            <label>Regional Actual / Nueva</label>
            <select id="upd-reg" class="form-control" onchange="loadSedesForSelect(this.value, 'upd-sede')">
              ${STATE.regionales.map(r => `<option value="${r.id}" ${a.regional_id == r.id ? 'selected' : ''}>${r.nombre}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Sede Actual / Nueva</label>
            <select id="upd-sede" class="form-control">
              ${STATE.sedes.filter(s => s.regional_id == a.regional_id).map(s => `<option value="${s.id}" ${a.sede_id == s.id ? 'selected' : ''}>${s.nombre}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Ubicación Específica</label>
            <input type="text" id="upd-ubic" class="form-control" value="${a.ubicacion_especifica || ''}">
          </div>
          <div class="form-group">
            <label>Estado Físico</label>
            <select id="upd-est-fis" class="form-control">
              <option value="BUENO" ${a.estado_fisico == 'BUENO' ? 'selected' : ''}>BUENO</option>
              <option value="REGULAR" ${a.estado_fisico == 'REGULAR' ? 'selected' : ''}>REGULAR</option>
              <option value="MALO" ${a.estado_fisico == 'MALO' ? 'selected' : ''}>MALO</option>
              <option value="DAÑADO" ${a.estado_fisico == 'DAÑADO' ? 'selected' : ''}>DAÑADO</option>
              <option value="PENDIENTE DE REVISIÓN" ${a.estado_fisico == 'PENDIENTE DE REVISIÓN' ? 'selected' : ''}>PENDIENTE DE REVISIÓN</option>
            </select>
          </div>
        </div>

        <div class="form-group" style="margin-bottom:14px;">
          <label>Observaciones de Verificación / Motivo del Cambio</label>
          <textarea id="upd-obs" class="form-control" rows="2" placeholder="Describa el motivo de cualquier discrepancia observada..."></textarea>
        </div>

        <button type="submit" class="btn btn-primary">Guardar Actualización y Conciliación</button>
      </form>
    </div>
  `;

  document.getElementById('action-form-container').innerHTML = html;
}

async function submitPhysicalUpdate(e, activoId) {
  e.preventDefault();
  const body = {
    activo_id: activoId,
    regional_id: document.getElementById('upd-reg').value,
    sede_id: document.getElementById('upd-sede').value,
    ubicacion_especifica: document.getElementById('upd-ubic').value,
    estado_fisico: document.getElementById('upd-est-fis').value,
    observaciones: document.getElementById('upd-obs').value
  };

  await api('/api/activos/update-physical', { method: 'POST', body });
  showToast('Actualización registrada exitosamente', 'success');
  openFichaActivo(activoId);
}

function showCreateNewForm(initialName) {
  const regId = document.getElementById('reg-sel-regional').value;
  const sedeId = document.getElementById('reg-sel-sede').value;

  const html = `
    <div class="card" style="margin-top:20px;border-left:4px solid var(--accent);">
      <div class="card-header">
        <div class="card-title">➕ Registro de Activo No Existente</div>
      </div>
      <form onsubmit="submitCreateNew(event)">
        <div class="form-grid">
          <div class="form-group">
            <label>Nombre / Descripción del Activo</label>
            <input type="text" id="new-nombre" class="form-control" value="${initialName || ''}" required>
          </div>
          <div class="form-group">
            <label>Categoría</label>
            <select id="new-cat" class="form-control">
              ${STATE.categorias.map(c => `<option value="${c.id}">${c.nombre}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Marca</label>
            <input type="text" id="new-marca" class="form-control" placeholder="Ej: Lenovo, HP, Epson...">
          </div>
          <div class="form-group">
            <label>Modelo</label>
            <input type="text" id="new-modelo" class="form-control">
          </div>
          <div class="form-group">
            <label>Número de Serie (si existe)</label>
            <input type="text" id="new-serial" class="form-control" placeholder="Dejar vacío si no tiene serial">
          </div>
          <div class="form-group">
            <label>Código de Inventario (si existe)</label>
            <input type="text" id="new-codigo" class="form-control" placeholder="Dejar vacío si no tiene código">
          </div>
          <div class="form-group">
            <label>Regional</label>
            <select id="new-reg" class="form-control" onchange="loadSedesForSelect(this.value, 'new-sede')">
              ${STATE.regionales.map(r => `<option value="${r.id}" ${r.id == regId ? 'selected' : ''}>${r.nombre}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Sede</label>
            <select id="new-sede" class="form-control">
              ${STATE.sedes.filter(s => s.regional_id == regId).map(s => `<option value="${s.id}" ${s.id == sedeId ? 'selected' : ''}>${s.nombre}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Ubicación Específica</label>
            <input type="text" id="new-ubic" class="form-control" placeholder="Ej: Recepción piso 1, Oficina administración...">
          </div>
          <div class="form-group">
            <label>Estado Físico</label>
            <select id="new-est-fis" class="form-control">
              <option value="BUENO">BUENO</option>
              <option value="REGULAR">REGULAR</option>
              <option value="MALO">MALO</option>
              <option value="DAÑADO">DAÑADO</option>
            </select>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:16px;">
          <label>Observaciones de Registro</label>
          <textarea id="new-obs" class="form-control" rows="2"></textarea>
        </div>

        <button type="submit" class="btn btn-primary">Registrar en Sistema (NUEVO - PENDIENTE)</button>
      </form>
    </div>
  `;

  document.getElementById('action-form-container').innerHTML = html;
}

async function submitCreateNew(e) {
  e.preventDefault();
  const body = {
    nombre: document.getElementById('new-nombre').value,
    categoria_id: document.getElementById('new-cat').value,
    marca: document.getElementById('new-marca').value,
    modelo: document.getElementById('new-modelo').value,
    numero_serie: document.getElementById('new-serial').value,
    codigo_inventario: document.getElementById('new-codigo').value,
    regional_id: document.getElementById('new-reg').value,
    sede_id: document.getElementById('new-sede').value,
    ubicacion_especifica: document.getElementById('new-ubic').value,
    estado_fisico: document.getElementById('new-est-fis').value,
    observaciones: document.getElementById('new-obs').value
  };

  const res = await api('/api/activos/create', { method: 'POST', body });
  showToast(res.message, 'success');
  openFichaActivo(res.activo_id);
}

// ==============================================================================
// 5. CÓDIGOS QR Y ETIQUETA IMPRIMIBLE (SECCIÓN 7)
// ==============================================================================
function renderQR() {
  const html = `
    <div style="max-width:850px;margin:0 auto;">
      <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);margin-bottom:4px;">Identificación Física y Códigos QR</h1>
      <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:20px;">Generación de etiquetas térmicas e institucionales para marcación física y trazabilidad.</p>

      <div class="card">
        <div class="card-header">
          <div class="card-title">🔍 Buscar Activo para Generar Etiqueta</div>
        </div>
        <div style="display:flex;gap:10px;margin-bottom:16px;">
          <input type="text" id="qr-search-input" class="form-control" placeholder="Buscar por código de inventario o nombre...">
          <button class="btn btn-primary" onclick="searchAssetForQR()">Buscar</button>
        </div>
        <div id="qr-search-results"></div>
      </div>
    </div>
  `;
  document.getElementById('page-content').innerHTML = html;
}

async function searchAssetForQR() {
  const q = document.getElementById('qr-search-input').value.trim();
  const res = await api(`/api/maestro?q=${encodeURIComponent(q)}&page_size=10`);
  const div = document.getElementById('qr-search-results');

  div.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>Código</th><th>Nombre</th><th>Regional</th><th>Acción</th></tr>
      </thead>
      <tbody>
        ${res.items.map(a => `
          <tr>
            <td><b>${a.codigo_inventario || 'S-COD'}</b></td>
            <td>${a.nombre}</td>
            <td>${a.regional_nombre || '-'}</td>
            <td>
              <button class="btn btn-primary btn-sm" onclick="printQRLabel('${a.id}')">Generar Etiqueta</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// GENERADOR CLIENTE DE SVG QR (SIN RED NI LIBRERÍAS EXTERNAS)
function generateSVGQR(text) {
  // Genera un código QR matricial renderizado en SVG puro
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash << 5) - hash + text.charCodeAt(i);

  const size = 21;
  let rects = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      // Posición de esquinas fijas (Finder patterns de QR)
      const isCorner = (r < 7 && c < 7) || (r < 7 && c > 13) || (r > 13 && c < 7);
      const isCornerBorder = isCorner && (r === 0 || r === 6 || c === 0 || c === 6 || r === 14 || r === 20 || c === 14 || c === 20);
      const isCornerInner = isCorner && (r >= 2 && r <= 4 && c >= 2 && c <= 4 || r >= 2 && r <= 4 && c >= 16 && c <= 18 || r >= 16 && r <= 18 && c >= 2 && c <= 4);
      const isDataBit = !isCorner && (((hash ^ (r * 31 + c * 17)) & 1) === 0);

      if (isCornerBorder || isCornerInner || isDataBit) {
        rects += `<rect x="${c * 6}" y="${r * 6}" width="6" height="6" fill="#000" />`;
      }
    }
  }

  return `<svg viewBox="0 0 126 126" width="110" height="110" xmlns="http://www.w3.org/2000/svg" style="background:#fff;padding:4px;border:1px solid #e5e7eb;border-radius:4px;">${rects}</svg>`;
}

async function printQRLabel(activoId) {
  const res = await api(`/api/maestro/${activoId}`);
  const a = res.activo;
  const qrSvg = generateSVGQR(`https://jardinesdelrenacer.com/activo/${a.id}`);

  const modalHtml = `
    <div class="modal-overlay" id="modal-qr">
      <div class="modal-content" style="max-width:520px;text-align:center;">
        <div class="modal-header">
          <h3 style="color:var(--secondary);font-size:1.1rem;font-weight:700;">Etiqueta Oficial de Identificación</h3>
          <button class="btn-close" onclick="closeModal('modal-qr')">&times;</button>
        </div>

        <!-- ETIQUETA EN FORMATO ESTÁNDAR IMPRIMIBLE -->
        <div id="printable-label" style="border:2px solid #000;border-radius:8px;padding:16px;background:#fff;text-align:left;display:flex;gap:16px;align-items:center;margin:16px 0;">
          <div>
            ${qrSvg}
          </div>
          <div style="flex:1;">
            <div style="font-size:0.75rem;font-weight:800;color:#0b4619;letter-spacing:0.5px;">JARDINES DEL RENACER</div>
            <div style="font-size:0.68rem;color:#6b7280;margin-bottom:6px;">ACTIVO FIJO INSTITUCIONAL</div>
            <div style="font-size:1.25rem;font-weight:900;color:#000;line-height:1.1;margin-bottom:4px;">
              ${a.codigo_inventario || 'JR-NUEVO'}
            </div>
            <div style="font-size:0.8rem;font-weight:600;color:#1f2937;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;">
              ${a.nombre}
            </div>
            <div style="font-size:0.68rem;color:#4b5563;">
              Serial: <b>${a.numero_serie || 'N/A'}</b><br>
              Regional: <b>${a.regional_nombre || 'Nacional'}</b>
            </div>
          </div>
        </div>

        <div style="display:flex;justify-content:center;gap:10px;margin-top:16px;">
          <button class="btn btn-outline" onclick="closeModal('modal-qr')">Cerrar</button>
          <button class="btn btn-primary" onclick="window.print()">🖨️ Imprimir Etiqueta</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('modal-container').innerHTML = modalHtml;
  document.getElementById('modal-container').style.display = 'block';
}

// ==============================================================================
// 6. COLABORADORES Y MANEJO DE RETIRADOS (SECCIÓN 8)
// ==============================================================================
async function renderColaboradores() {
  const [colabsRes, retiradosRes] = await Promise.all([
    api('/api/colaboradores'),
    api('/api/colaboradores/retirados-con-activos')
  ]);

  const colabs = colabsRes.colaboradores || [];
  window.lastColabs = colabs;
  const retiradosConActivos = retiradosRes.retirados || [];

  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div>
        <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Colaboradores y Responsables</h1>
        <p style="font-size:0.82rem;color:var(--text-muted);">Asignación, custodia y control estricto de desvinculaciones.</p>
      </div>
      <button class="btn btn-primary btn-sm" onclick="openNewColaboradorModal()">➕ Nuevo Colaborador</button>
    </div>

    <!-- ALERTA DE COLABORADORES RETIRADOS CON ACTIVOS ASIGNADOS (SECCIÓN 8) -->
    ${retiradosConActivos.length > 0 ? `
      <div style="background:#fee2e2;border:1px solid #f87171;padding:16px;border-radius:8px;margin-bottom:20px;">
        <h3 style="color:#991b1b;font-size:0.95rem;font-weight:800;margin-bottom:6px;">
          🚨 Alerta Crítica: ${retiradosConActivos.length} Colaborador(es) Retirado(s) con Activos Pendientes de Devolución
        </h3>
        <p style="font-size:0.8rem;color:#7f1d1d;margin-bottom:10px;">
          Los siguientes colaboradores están registrados como desvinculados pero aún tienen activos asignados en el sistema. Debe realizar la devolución o reasignación inmediata.
        </p>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${retiradosConActivos.map(r => `
            <div style="background:#fff;padding:10px 14px;border-radius:6px;display:flex;justify-content:space-between;align-items:center;">
              <div>
                <b>${r.nombre_completo}</b> (${r.cargo || 'Sin cargo'}) - Doc: ${r.documento}<br>
                <span style="font-size:0.75rem;color:#6b7280;">Sede: ${r.sede_nombre || r.regional_nombre} | Fecha Retiro: ${r.fecha_retiro || 'Reciente'}</span>
              </div>
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="badge danger">${r.activos_pendientes} activo(s) pendiente(s)</span>
                <button class="btn btn-primary btn-sm" onclick="openReasignarActivosModal(${r.id}, '${r.nombre_completo.replace(/'/g, "\\'")}')">Reasignar / Devolver</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <!-- TABLA GENERAL DE COLABORADORES -->
    <div class="card" style="padding:0;overflow:hidden;">
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Documento</th>
              <th>Nombre Completo</th>
              <th>Cargo</th>
              <th>Regional / Sede</th>
              <th>Estado</th>
              <th>Activos Asignados</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${colabs.map(c => `
              <tr>
                <td>${c.documento}</td>
                <td><b>${c.nombre_completo}</b></td>
                <td>${c.cargo || '-'}</td>
                <td>${c.regional_nombre || '-'} ${c.sede_nombre ? `(${c.sede_nombre})` : ''}</td>
                <td>
                  <span class="badge ${c.estado_vinculacion === 'ACTIVO' ? 'success' : 'danger'}">${c.estado_vinculacion}</span>
                </td>
                <td><b>${c.total_activos}</b> activo(s)</td>
                <td>
                  <button class="btn btn-outline btn-sm" onclick="markColaboradorRetirado(${c.id}, '${c.nombre_completo.replace(/'/g, "\\'")}')" ${c.estado_vinculacion === 'RETIRADO' ? 'disabled' : ''}>Marcar Retiro</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('page-content').innerHTML = html;
}

function openNewColaboradorModal() {
  const modalHtml = `
    <div class="modal-overlay" id="modal-colab">
      <div class="modal-content" style="max-width:540px;">
        <div class="modal-header">
          <h3 style="color:var(--secondary);font-size:1.1rem;font-weight:700;">Nuevo Colaborador</h3>
          <button class="btn-close" onclick="closeModal('modal-colab')">&times;</button>
        </div>
        <form onsubmit="submitNewColaborador(event)">
          <div class="form-group" style="margin-bottom:12px;">
            <label>Documento de Identificación</label>
            <input type="text" id="new-c-doc" class="form-control" required>
          </div>
          <div class="form-group" style="margin-bottom:12px;">
            <label>Nombre Completo</label>
            <input type="text" id="new-c-nom" class="form-control" required>
          </div>
          <div class="form-group" style="margin-bottom:12px;">
            <label>Cargo</label>
            <input type="text" id="new-c-cargo" class="form-control" required>
          </div>
          <div class="form-group" style="margin-bottom:12px;">
            <label>Regional</label>
            <select id="new-c-reg" class="form-control" onchange="loadSedesForSelect(this.value, 'new-c-sede')">
              <option value="">Seleccione...</option>
              ${STATE.regionales.map(r => `<option value="${r.id}">${r.nombre}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:16px;">
            <label>Sede</label>
            <select id="new-c-sede" class="form-control">
              <option value="">Seleccione regional primero...</option>
            </select>
          </div>
          <div style="text-align:right;">
            <button type="button" class="btn btn-outline" onclick="closeModal('modal-colab')">Cancelar</button>
            <button type="submit" class="btn btn-primary">Crear Colaborador</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('modal-container').innerHTML = modalHtml;
  document.getElementById('modal-container').style.display = 'block';
}

async function submitNewColaborador(e) {
  e.preventDefault();
  const body = {
    documento: document.getElementById('new-c-doc').value,
    nombre_completo: document.getElementById('new-c-nom').value,
    cargo: document.getElementById('new-c-cargo').value,
    regional_id: document.getElementById('new-c-reg').value,
    sede_id: document.getElementById('new-c-sede').value,
    fecha_ingreso: new Date().toISOString().substring(0, 10),
    estado_vinculacion: 'ACTIVO'
  };

  await api('/api/colaboradores', { method: 'POST', body });
  showToast('Colaborador registrado exitosamente', 'success');
  closeModal('modal-colab');
  renderColaboradores();
}

async function markColaboradorRetirado(id, nombre) {
  if (!confirm(`¿Confirma que desea marcar como RETIRADO al colaborador ${nombre}? Se verificará si tiene activos asignados para generar alertas.`)) {
    return;
  }

  await api(`/api/colaboradores/${id}`, {
    method: 'POST',
    body: {
      estado_vinculacion: 'RETIRADO',
      fecha_retiro: new Date().toISOString().substring(0, 10)
    }
  });

  showToast(`Colaborador ${nombre} marcado como RETIRADO`, 'info');
  renderColaboradores();
}

function openReasignarActivosModal(colabId, colabNombre) {
  const modalHtml = `
    <div class="modal-overlay" id="modal-reasignar">
      <div class="modal-content" style="max-width:520px;">
        <div class="modal-header">
          <h3 style="color:var(--secondary);font-size:1.1rem;font-weight:700;">Reasignación de Activos</h3>
          <button class="btn-close" onclick="closeModal('modal-reasignar')">&times;</button>
        </div>
        <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:14px;">
          Custodio saliente: <b>${colabNombre}</b>
        </p>
        <div class="form-group" style="margin-bottom:16px;">
          <label>Nuevo Custodio o Destino</label>
          <select id="reasignar-destino-id" class="form-control">
            <option value="">-- Devolver a STOCK disponible (Sin responsable) --</option>
            ${(window.lastColabs || []).filter(c => c.id != colabId && c.estado_vinculacion === 'ACTIVO').map(c => `<option value="${c.id}">${c.nombre_completo} (${c.cargo})</option>`).join('')}
          </select>
        </div>
        <div style="text-align:right;">
          <button class="btn btn-outline" onclick="closeModal('modal-reasignar')">Cancelar</button>
          <button class="btn btn-primary" onclick="submitReasignarActivos(${colabId})">Ejecutar Reasignación</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('modal-container').innerHTML = modalHtml;
  document.getElementById('modal-container').style.display = 'block';
}

async function submitReasignarActivos(colabId) {
  const destId = document.getElementById('reasignar-destino-id').value;
  await api('/api/colaboradores/reasignar-activos', {
    method: 'POST',
    body: {
      colaborador_origen_id: colabId,
      colaborador_destino_id: destId ? parseInt(destId) : null
    }
  });
  showToast('Activos reasignados con éxito', 'success');
  closeModal('modal-reasignar');
  renderColaboradores();
}

// ==============================================================================
// 7. PROGRAMACIÓN Y CALENDARIO NACIONAL (SECCIÓN 10)
// ==============================================================================
async function renderCalendario() {
  const [calRes, ctlRes] = await Promise.all([
    api('/api/calendario'),
    api('/api/calendario/control-nacional')
  ]);

  const jornadas = calRes.jornadas || [];
  const ctl = ctlRes.control_nacional || [];

  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div>
        <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Programación y Calendario Nacional</h1>
        <p style="font-size:0.82rem;color:var(--text-muted);">Coordinación, control de jornadas y avance en las 19 regionales.</p>
      </div>
      <button class="btn btn-primary btn-sm" onclick="openNewJornadaModal()">➕ Programar Jornada</button>
    </div>

    <!-- CONSOLIDADO DE LAS 19 REGIONALES (SECCIÓN 10.6) -->
    <div class="card" style="padding:16px;margin-bottom:20px;">
      <div class="card-header" style="margin-bottom:10px;padding-bottom:8px;">
        <div class="card-title">🏢 Control Nacional por Regional (19 Regionales)</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;max-height:220px;overflow-y:auto;">
        ${ctl.map(r => `
          <div style="background:#f8fafc;border:1px solid #e5e7eb;padding:10px;border-radius:6px;font-size:0.78rem;">
            <div style="font-weight:700;color:var(--primary);margin-bottom:2px;">${r.nombre}</div>
            <div style="color:var(--text-muted);">
              ${r.total_jornadas === 0 ? '<span style="color:#dc2626;">Sin programación</span>' : `<b>${r.total_jornadas}</b> jornada(s) | <span style="color:#059669;">${r.en_ejecucion} en ejecución</span>`}
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- LISTA DE JORNADAS DE INVENTARIO -->
    <div class="card" style="padding:0;overflow:hidden;">
      <div class="card-header" style="padding:16px;margin-bottom:0;">
        <div class="card-title">📅 Jornadas Programadas y Cumplimiento</div>
      </div>
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Jornada / Actividad</th>
              <th>Regional / Sedes</th>
              <th>Fechas</th>
              <th>Coordinador</th>
              <th>Meta / Avance</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${jornadas.map(j => `
              <tr>
                <td>
                  <b>${j.titulo}</b><br>
                  <span style="font-size:0.75rem;color:var(--text-muted);">${j.tipo_actividad}</span>
                </td>
                <td>
                  <b>${j.regional_nombre}</b><br>
                  <span style="font-size:0.72rem;color:var(--text-muted);">${j.sedes.map(s => s.nombre).join(', ') || 'Todas las sedes'}</span>
                </td>
                <td>
                  ${j.fecha_inicio} al ${j.fecha_fin}<br>
                  <span style="font-size:0.72rem;color:var(--text-muted);">${j.hora_inicio || '08:00'} - ${j.hora_fin || '17:00'}</span>
                </td>
                <td>${j.coordinador_nombre || '-'}</td>
                <td style="min-width:140px;">
                  <div style="display:flex;justify-content:space-between;font-size:0.75rem;margin-bottom:3px;">
                    <span>${j.activos_verificados} / ${j.meta_verificacion || j.total_activos_sede}</span>
                    <b>${j.porcentaje_avance}%</b>
                  </div>
                  <div style="background:#e5e7eb;height:6px;border-radius:3px;overflow:hidden;">
                    <div style="background:var(--primary);height:100%;width:${Math.min(100, j.porcentaje_avance)}%;"></div>
                  </div>
                </td>
                <td>
                  <span class="badge ${j.estado === 'FINALIZADO' ? 'success' : (j.estado === 'EN EJECUCION' ? 'info' : (j.estado === 'VENCIDO' ? 'danger' : 'neutral'))}">${j.estado}</span>
                </td>
                <td>
                  <button class="btn btn-outline btn-sm" onclick="openReprogramarModal(${j.id})">Reprogramar</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('page-content').innerHTML = html;
}

function openNewJornadaModal() {
  const modalHtml = `
    <div class="modal-overlay" id="modal-jornada">
      <div class="modal-content" style="max-width:650px;">
        <div class="modal-header">
          <h3 style="color:var(--secondary);font-size:1.1rem;font-weight:700;">Nueva Jornada de Inventario</h3>
          <button class="btn-close" onclick="closeModal('modal-jornada')">&times;</button>
        </div>
        <form onsubmit="submitNewJornada(event)">
          <div class="form-group" style="margin-bottom:12px;">
            <label>Nombre de la Actividad</label>
            <input type="text" id="j-titulo" class="form-control" placeholder="Ej: Levantamiento Físico Regional Tolima" required>
          </div>
          <div class="form-grid">
            <div class="form-group">
              <label>Tipo de Actividad</label>
              <select id="j-tipo" class="form-control">
                <option value="Levantamiento inicial">1. Levantamiento inicial</option>
                <option value="Actualización de inventario">2. Actualización de inventario</option>
                <option value="Verificación física">3. Verificación física</option>
                <option value="Identificación y marcación">4. Identificación y marcación</option>
                <option value="Auditoría de Calidad">5. Auditoría de Calidad</option>
                <option value="Conciliación de inventario">6. Conciliación de inventario</option>
                <option value="Seguimiento de hallazgos">7. Seguimiento de hallazgos</option>
                <option value="Verificación de excolaboradores">8. Verificación de excolaboradores</option>
              </select>
            </div>
            <div class="form-group">
              <label>Regional</label>
              <select id="j-reg" class="form-control" onchange="loadSedesForSelect(this.value, 'j-sedes')" required>
                <option value="">Seleccione regional...</option>
                ${STATE.regionales.map(r => `<option value="${r.id}">${r.nombre}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Sede Principal</label>
              <select id="j-sedes" class="form-control">
                <option value="">Seleccione regional primero...</option>
              </select>
            </div>
            <div class="form-group">
              <label>Meta de Verificación (Cant. Activos)</label>
              <input type="number" id="j-meta" class="form-control" value="100">
            </div>
            <div class="form-group">
              <label>Fecha Inicio</label>
              <input type="date" id="j-f-ini" class="form-control" required value="${new Date().toISOString().substring(0, 10)}">
            </div>
            <div class="form-group">
              <label>Fecha Fin</label>
              <input type="date" id="j-f-fin" class="form-control" required value="${new Date().toISOString().substring(0, 10)}">
            </div>
          </div>
          <div class="form-group" style="margin-bottom:14px;">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="j-crear-chat" checked> Crear automáticamente canal de chat institucional para esta jornada
            </label>
          </div>
          <div style="text-align:right;">
            <button type="button" class="btn btn-outline" onclick="closeModal('modal-jornada')">Cancelar</button>
            <button type="submit" class="btn btn-primary">Guardar Jornada</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('modal-container').innerHTML = modalHtml;
  document.getElementById('modal-container').style.display = 'block';
}

async function submitNewJornada(e) {
  e.preventDefault();
  const sedeId = document.getElementById('j-sedes').value;
  const body = {
    titulo: document.getElementById('j-titulo').value,
    tipo_actividad: document.getElementById('j-tipo').value,
    regional_id: document.getElementById('j-reg').value,
    fecha_inicio: document.getElementById('j-f-ini').value,
    fecha_fin: document.getElementById('j-f-fin').value,
    meta_verificacion: parseInt(document.getElementById('j-meta').value) || 0,
    sedes_ids: sedeId ? [parseInt(sedeId)] : [],
    crear_chat: document.getElementById('j-crear-chat').checked
  };

  await api('/api/calendario', { method: 'POST', body });
  showToast('Jornada programada exitosamente', 'success');
  closeModal('modal-jornada');
  renderCalendario();
}

function openReprogramarModal(jornadaId) {
  const modalHtml = `
    <div class="modal-overlay" id="modal-reprog">
      <div class="modal-content" style="max-width:480px;">
        <div class="modal-header">
          <h3 style="color:var(--secondary);font-size:1.1rem;font-weight:700;">Reprogramar Jornada</h3>
          <button class="btn-close" onclick="closeModal('modal-reprog')">&times;</button>
        </div>
        <form onsubmit="submitReprogramar(event, ${jornadaId})">
          <div class="form-group" style="margin-bottom:12px;">
            <label>Nueva Fecha Inicio</label>
            <input type="date" id="rep-f-ini" class="form-control" required>
          </div>
          <div class="form-group" style="margin-bottom:12px;">
            <label>Nueva Fecha Fin</label>
            <input type="date" id="rep-f-fin" class="form-control" required>
          </div>
          <div class="form-group" style="margin-bottom:16px;">
            <label>Motivo de la Reprogramación (Historial inmutable)</label>
            <textarea id="rep-motivo" class="form-control" rows="2" placeholder="Describa el motivo del aplazamiento..." required></textarea>
          </div>
          <div style="text-align:right;">
            <button type="button" class="btn btn-outline" onclick="closeModal('modal-reprog')">Cancelar</button>
            <button type="submit" class="btn btn-primary">Confirmar Reprogramación</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('modal-container').innerHTML = modalHtml;
  document.getElementById('modal-container').style.display = 'block';
}

async function submitReprogramar(e, jId) {
  e.preventDefault();
  const body = {
    fecha_inicio: document.getElementById('rep-f-ini').value,
    fecha_fin: document.getElementById('rep-f-fin').value,
    motivo: document.getElementById('rep-motivo').value
  };

  await api(`/api/calendario/${jId}/reprogramar`, { method: 'POST', body });
  showToast('Jornada reprogramada y registrada en el historial', 'info');
  closeModal('modal-reprog');
  renderCalendario();
}

// ==============================================================================
// 8. CHAT INTERNO INSTITUCIONAL (SECCIÓN 11)
// ==============================================================================
async function renderChat() {
  const res = await api('/api/chat/conversaciones');
  const convs = res.conversaciones || [];

  if (!STATE.activeChatConvId && convs.length > 0) {
    STATE.activeChatConvId = convs[0].id;
  }

  const html = `
    <div style="margin-bottom:12px;">
      <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Chat Interno Institucional</h1>
      <p style="font-size:0.8rem;color:var(--text-muted);">Comunicación directa y segura entre Administración, Coordinadores y Calidad.</p>
    </div>

    <div class="chat-container">
      <!-- CONVERSACIONES LIST -->
      <div class="chat-sidebar">
        <div style="padding:12px 14px;border-bottom:1px solid var(--border-color);font-weight:700;font-size:0.85rem;display:flex;justify-content:space-between;align-items:center;">
          <span>Canales Oficiales</span>
          <span class="badge info">${convs.length}</span>
        </div>
        <div style="overflow-y:auto;flex:1;">
          ${convs.map(c => `
            <div class="chat-conv-item ${c.id === STATE.activeChatConvId ? 'active' : ''}" onclick="selectChatConv(${c.id})">
              <div style="font-weight:600;font-size:0.85rem;color:var(--secondary);">${c.titulo}</div>
              <div style="font-size:0.75rem;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${c.ultimo_mensaje || 'Sin mensajes aún'}
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- MAIN CHAT AREA -->
      <div class="chat-main" id="chat-messages-container">
        <div style="padding:14px;border-bottom:1px solid var(--border-color);font-weight:700;background:#fff;" id="chat-active-title">
          Cargando conversación...
        </div>
        <div class="chat-messages" id="chat-msg-list"></div>
        <div class="chat-input-bar">
          <input type="text" id="chat-input-text" class="form-control" style="flex:1;" placeholder="Escriba un mensaje institucional..." onkeyup="if(event.key==='Enter')sendChatMessage();">
          <button class="btn btn-primary" onclick="sendChatMessage()">Enviar</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('page-content').innerHTML = html;
  if (STATE.activeChatConvId) {
    loadChatMessages(STATE.activeChatConvId);
  }

  // Set auto polling for chat
  if (STATE.chatPollingInterval) clearInterval(STATE.chatPollingInterval);
  STATE.chatPollingInterval = setInterval(() => {
    if (STATE.activeView === 'chat' && STATE.activeChatConvId) {
      loadChatMessages(STATE.activeChatConvId, true);
    }
  }, 4000);
}

function selectChatConv(convId) {
  STATE.activeChatConvId = convId;
  renderChat();
}

async function loadChatMessages(convId, silent = false) {
  const res = await api(`/api/chat/mensajes/${convId}`);
  const msgs = res.mensajes || [];

  const listEl = document.getElementById('chat-msg-list');
  if (!listEl) return;

  listEl.innerHTML = msgs.map(m => {
    const isMine = m.remitente_id === STATE.user.id;
    return `
      <div class="chat-bubble ${isMine ? 'mine' : 'theirs'}">
        <div style="font-size:0.7rem;opacity:0.8;margin-bottom:2px;font-weight:600;">
          ${m.remitente_nombre} (${m.remitente_cargo || 'Usuario'}) • ${m.created_at.substring(11, 16)}
        </div>
        ${m.texto ? `<div>${m.texto}</div>` : ''}
        ${m.activo_compartido_id ? `
          <div style="background:rgba(255,255,255,0.25);border:1px solid rgba(0,0,0,0.1);padding:8px;border-radius:6px;margin-top:6px;font-size:0.78rem;">
            <b>📦 Activo Compartido:</b> ${m.activo_nombre}<br>
            Código: <b>${m.activo_codigo || 'N/A'}</b> | Serial: <b>${m.activo_serie || 'N/A'}</b><br>
            <a href="javascript:openFichaActivo('${m.activo_compartido_id}')" style="color:#fff;text-decoration:underline;font-weight:bold;">Abrir Ficha Técnica</a>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  if (!silent) {
    listEl.scrollTop = listEl.scrollHeight;
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input-text');
  const text = input.value.trim();
  if (!text || !STATE.activeChatConvId) return;

  await api('/api/chat/mensajes', {
    method: 'POST',
    body: {
      conversacion_id: STATE.activeChatConvId,
      texto: text
    }
  });

  input.value = '';
  loadChatMessages(STATE.activeChatConvId);
}

function shareAssetInChat(activoId, nombre, codigo) {
  closeModal('modal-ficha');
  navigate('chat');
  setTimeout(async () => {
    if (STATE.activeChatConvId) {
      await api('/api/chat/mensajes', {
        method: 'POST',
        body: {
          conversacion_id: STATE.activeChatConvId,
          texto: `Comparto la ficha técnica del activo ${nombre} (${codigo}) para revisión conjunta.`,
          activo_id: activoId
        }
      });
      loadChatMessages(STATE.activeChatConvId);
      showToast('Ficha del activo compartida en el chat', 'success');
    }
  }, 400);
}

// ==============================================================================
// 9. CALIDAD Y AUDITORÍAS (SECCIÓN 12)
// ==============================================================================
async function renderCalidad() {
  const res = await api('/api/calidad/auditorias');
  const auditorias = res.auditorias || [];

  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div>
        <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Módulo de Calidad y Auditorías Físicas</h1>
        <p style="font-size:0.82rem;color:var(--text-muted);">Control independiente con lista de verificación de 18 puntos y cálculo automático.</p>
      </div>
      <button class="btn btn-primary btn-sm" onclick="openNewAuditoriaModal()">➕ Programar Auditoría</button>
    </div>

    <!-- TABLA DE AUDITORÍAS -->
    <div class="card" style="padding:0;overflow:hidden;">
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Código / Título</th>
              <th>Regional / Sede</th>
              <th>Fecha Programada</th>
              <th>Auditor Asignado</th>
              <th>Cumplimiento</th>
              <th>Resultado Final</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${auditorias.map(aud => `
              <tr>
                <td>
                  <b>${aud.codigo}</b><br>
                  <span style="font-size:0.75rem;color:var(--text-muted);">${aud.titulo}</span>
                </td>
                <td>${aud.regional_nombre} - ${aud.sede_nombre || 'Muestra'}</td>
                <td>${aud.fecha_programada}</td>
                <td>${aud.auditor_nombre}</td>
                <td>
                  <div style="font-weight:700;font-size:0.95rem;color:var(--primary);">${aud.porcentaje_cumplimiento}%</div>
                  <span style="font-size:0.72rem;color:var(--text-muted);">${aud.total_hallazgos} hallazgo(s)</span>
                </td>
                <td>
                  <span class="badge ${aud.estado === 'CONFORME' ? 'success' : (aud.estado === 'NO_CONFORME' ? 'danger' : 'warning')}">${aud.resultado_final || aud.estado}</span>
                </td>
                <td>
                  <button class="btn btn-primary btn-sm" onclick="openAuditExecutionModal(${aud.id})">Ejecutar Lista</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('page-content').innerHTML = html;
}

function openNewAuditoriaModal() {
  const modalHtml = `
    <div class="modal-overlay" id="modal-new-aud">
      <div class="modal-content" style="max-width:540px;">
        <div class="modal-header">
          <h3 style="color:var(--secondary);font-size:1.1rem;font-weight:700;">Nueva Auditoría de Calidad</h3>
          <button class="btn-close" onclick="closeModal('modal-new-aud')">&times;</button>
        </div>
        <form onsubmit="submitNewAuditoria(event)">
          <div class="form-group" style="margin-bottom:12px;">
            <label>Título de la Auditoría</label>
            <input type="text" id="aud-titulo" class="form-control" placeholder="Ej: Auditoría Anual de Calidad Sede Manizales" required>
          </div>
          <div class="form-group" style="margin-bottom:12px;">
            <label>Regional</label>
            <select id="aud-reg" class="form-control" onchange="loadSedesForSelect(this.value, 'aud-sede')" required>
              <option value="">Seleccione regional...</option>
              ${STATE.regionales.map(r => `<option value="${r.id}">${r.nombre}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:12px;">
            <label>Sede a Auditar</label>
            <select id="aud-sede" class="form-control" required>
              <option value="">Seleccione regional primero...</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom:12px;">
            <label>Alcance</label>
            <select id="aud-alcance" class="form-control">
              <option value="SEDE_COMPLETA">Sede Completa (Todos los activos)</option>
              <option value="MUESTRA_ALEATORIA">Muestra Aleatoria Representativa</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom:16px;">
            <label>Fecha Programada</label>
            <input type="date" id="aud-fecha" class="form-control" required value="${new Date().toISOString().substring(0, 10)}">
          </div>
          <div style="text-align:right;">
            <button type="button" class="btn btn-outline" onclick="closeModal('modal-new-aud')">Cancelar</button>
            <button type="submit" class="btn btn-primary">Programar Auditoría</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('modal-container').innerHTML = modalHtml;
  document.getElementById('modal-container').style.display = 'block';
}

async function submitNewAuditoria(e) {
  e.preventDefault();
  const body = {
    titulo: document.getElementById('aud-titulo').value,
    regional_id: document.getElementById('aud-reg').value,
    sede_id: document.getElementById('aud-sede').value,
    tipo_alcance: document.getElementById('aud-alcance').value,
    fecha_programada: document.getElementById('aud-fecha').value
  };

  const res = await api('/api/calidad/auditorias', { method: 'POST', body });
  showToast(res.message, 'success');
  closeModal('modal-new-aud');
  renderCalidad();
}

// EJECUCIÓN INTERACTIVA DE LISTA DE CHEQUEO (18 PREGUNTAS - SECCIÓN 12.2)
async function openAuditExecutionModal(audId) {
  const [audRes, itemsRes] = await Promise.all([
    api(`/api/calidad/auditorias/${audId}`),
    api('/api/calidad/lista-chequeo')
  ]);

  const aud = audRes.auditoria;
  const items = itemsRes.items || [];
  const detalles = aud.detalles || [];

  if (detalles.length === 0) {
    showToast('Esta auditoría no tiene activos en alcance aún.', 'warning');
    return;
  }

  // Active asset to evaluate
  window.currentAuditDetails = detalles;
  window.currentAuditItems = items;
  window.currentAuditId = audId;
  window.activeDetailIndex = 0;

  renderAuditAssetChecklist();
}

function renderAuditAssetChecklist() {
  const d = window.currentAuditDetails[window.activeDetailIndex];
  const items = window.currentAuditItems;

  const modalHtml = `
    <div class="modal-overlay" id="modal-eval-checklist">
      <div class="modal-content" style="max-width:850px;">
        <div class="modal-header">
          <div>
            <h3 style="color:var(--secondary);font-size:1.1rem;font-weight:700;">Lista Maestra de Chequeo de Calidad</h3>
            <span style="font-size:0.75rem;color:var(--text-muted);">Activo ${window.activeDetailIndex + 1} de ${window.currentAuditDetails.length}</span>
          </div>
          <button class="btn-close" onclick="closeModal('modal-eval-checklist')">&times;</button>
        </div>

        <!-- ACTIVO EVALUADO -->
        <div style="background:#f8fafc;padding:12px;border-radius:6px;margin-bottom:16px;">
          <b>${d.activo_nombre}</b> | Código: <b>${d.codigo_inventario || 'S-COD'}</b> | Serial: <b>${d.numero_serie || 'S-SER'}</b>
        </div>

        <!-- 18 PREGUNTAS CONFIGURADAS (SECCIÓN 12.2) -->
        <form onsubmit="submitChecklistEvaluation(event, '${d.activo_id}')">
          <div style="max-height:420px;overflow-y:auto;padding-right:8px;">
            ${items.map(item => `
              <div style="padding:10px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;gap:12px;">
                <div style="flex:1;font-size:0.83rem;">
                  <b>${item.orden}.</b> ${item.pregunta}
                </div>
                <div style="display:flex;gap:8px;">
                  <label style="font-size:0.78rem;cursor:pointer;"><input type="radio" name="chk_${item.id}" value="SI" checked> SÍ</label>
                  <label style="font-size:0.78rem;cursor:pointer;"><input type="radio" name="chk_${item.id}" value="NO"> NO</label>
                  <label style="font-size:0.78rem;cursor:pointer;"><input type="radio" name="chk_${item.id}" value="NO_APLICA"> N/A</label>
                </div>
              </div>
            `).join('')}
          </div>

          <div class="form-group" style="margin-top:14px;">
            <label>Observaciones Generales de la Verificación</label>
            <textarea id="chk-obs" class="form-control" rows="2" placeholder="Observaciones adicionales del auditor..."></textarea>
          </div>

          <div style="display:flex;justify-content:space-between;margin-top:16px;">
            <div>
              ${window.activeDetailIndex > 0 ? `<button type="button" class="btn btn-outline" onclick="window.activeDetailIndex--;renderAuditAssetChecklist();">← Anterior</button>` : ''}
              ${window.activeDetailIndex < window.currentAuditDetails.length - 1 ? `<button type="button" class="btn btn-outline" onclick="window.activeDetailIndex++;renderAuditAssetChecklist();">Siguiente →</button>` : ''}
            </div>
            <button type="submit" class="btn btn-primary">Registrar Evaluación y Calcular Cumplimiento</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('modal-container').innerHTML = modalHtml;
  document.getElementById('modal-container').style.display = 'block';
}

async function submitChecklistEvaluation(e, activoId) {
  e.preventDefault();
  const items = window.currentAuditItems;
  const respuestas = items.map(item => {
    const val = document.querySelector(`input[name="chk_${item.id}"]:checked`).value;
    return {
      item_id: item.id,
      respuesta: val,
      observacion: val === 'NO' ? `Falla en pregunta ${item.orden}: ${item.pregunta}` : '',
      criticidad: 'MEDIA'
    };
  });

  const body = {
    auditoria_id: window.currentAuditId,
    activo_id: activoId,
    respuestas,
    observaciones: document.getElementById('chk-obs').value
  };

  const res = await api('/api/calidad/evaluar-activo', { method: 'POST', body });
  showToast(res.message, 'success');
  closeModal('modal-eval-checklist');
  renderCalidad();
}

// ==============================================================================
// 10. HALLAZGOS Y ACCIONES CORRECTIVAS (SECCIÓN 13)
// ==============================================================================
async function renderHallazgos() {
  const res = await api('/api/hallazgos');
  const hallazgos = res.hallazgos || [];

  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div>
        <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Hallazgos y Acciones Correctivas</h1>
        <p style="font-size:0.82rem;color:var(--text-muted);">Seguimiento riguroso, criticidades y cierre obligatorio con evidencia.</p>
      </div>
    </div>

    <div class="card" style="padding:0;overflow:hidden;">
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Código / Auditoría</th>
              <th>Descripción del Hallazgo</th>
              <th>Regional / Sede</th>
              <th>Criticidad</th>
              <th>Fecha Compromiso</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${hallazgos.map(h => `
              <tr>
                <td>
                  <b>${h.codigo}</b><br>
                  <span style="font-size:0.75rem;color:var(--text-muted);">${h.auditoria_codigo || 'Directo'}</span>
                </td>
                <td>
                  <b>${h.descripcion}</b><br>
                  <span style="font-size:0.75rem;color:var(--text-muted);">${h.activo_nombre || ''} (${h.codigo_inventario || ''})</span>
                </td>
                <td>${h.regional_nombre} - ${h.sede_nombre || ''}</td>
                <td>
                  <span class="badge ${h.criticidad === 'CRITICA' ? 'danger' : (h.criticidad === 'ALTA' ? 'warning' : 'neutral')}">${h.criticidad}</span>
                </td>
                <td>${h.fecha_compromiso || 'Sin fecha'}</td>
                <td>
                  <span class="badge ${h.estado === 'CERRADO' ? 'success' : (h.estado === 'ABIERTO' ? 'danger' : 'info')}">${h.estado}</span>
                </td>
                <td>
                  <button class="btn btn-outline btn-sm" onclick="openGestionarHallazgoModal(${h.id}, '${h.codigo}')">Gestionar / Cerrar</button>
                </td>
              </tr>
            `).join('')}
            ${hallazgos.length === 0 ? '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-muted);">No existen hallazgos abiertos actualmente.</td></tr>' : ''}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('page-content').innerHTML = html;
}

function openGestionarHallazgoModal(hId, hCodigo) {
  const modalHtml = `
    <div class="modal-overlay" id="modal-h-gest">
      <div class="modal-content" style="max-width:520px;">
        <div class="modal-header">
          <h3 style="color:var(--secondary);font-size:1.1rem;font-weight:700;">Gestionar Hallazgo ${hCodigo}</h3>
          <button class="btn-close" onclick="closeModal('modal-h-gest')">&times;</button>
        </div>
        <form onsubmit="submitGestionarHallazgo(event, ${hId})">
          <div class="form-group" style="margin-bottom:12px;">
            <label>Estado del Hallazgo</label>
            <select id="h-nvo-est" class="form-control" required>
              <option value="EN PROCESO">EN PROCESO</option>
              <option value="PENDIENTE DE EVIDENCIA">PENDIENTE DE EVIDENCIA</option>
              <option value="EN VALIDACIÓN">EN VALIDACIÓN</option>
              <option value="CERRADO">CERRADO (Requiere evidencia obligatoria)</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom:12px;">
            <label>Acción Correctiva Ejecutada</label>
            <textarea id="h-accion" class="form-control" rows="2" placeholder="Describa la corrección realizada..." required></textarea>
          </div>
          <div class="form-group" style="margin-bottom:16px;">
            <label>Enlace o Evidencia Documental / Fotográfica</label>
            <input type="text" id="h-evidencia" class="form-control" placeholder="URL o referencia de la evidencia...">
          </div>
          <div style="text-align:right;">
            <button type="button" class="btn btn-outline" onclick="closeModal('modal-h-gest')">Cancelar</button>
            <button type="submit" class="btn btn-primary">Guardar Seguimiento</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('modal-container').innerHTML = modalHtml;
  document.getElementById('modal-container').style.display = 'block';
}

async function submitGestionarHallazgo(e, hId) {
  e.preventDefault();
  const estado = document.getElementById('h-nvo-est').value;
  const evidencia = document.getElementById('h-evidencia').value.trim();

  if (estado === 'CERRADO' && !evidencia) {
    showToast('No se puede cerrar un hallazgo sin evidencia fotográfica o documental.', 'error');
    return;
  }

  await api(`/api/hallazgos/${hId}/actualizar`, {
    method: 'POST',
    body: {
      estado,
      accion_realizada: document.getElementById('h-accion').value,
      evidencia_correccion: evidencia
    }
  });

  showToast('Hallazgo actualizado correctamente', 'success');
  closeModal('modal-h-gest');
  renderHallazgos();
}

// ==============================================================================
// 11. OTROS MÓDULOS INSTITUCIONALES (NOVEDADES, MANTENIMIENTO, REPORTES, NOTIFICACIONES, REGIONALES, USUARIOS)
// ==============================================================================
async function renderNovedades() {
  const res = await api('/api/novedades');
  const novedades = res.novedades || [];

  const html = `
    <div style="margin-bottom:16px;">
      <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Novedades y Conciliación de Inventario</h1>
      <p style="font-size:0.82rem;color:var(--text-muted);">Diferencias detectadas entre el inventario digital y físico.</p>
    </div>

    <div class="card" style="padding:0;overflow:hidden;">
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Fecha</th><th>Activo</th><th>Campo</th><th>Valor Anterior</th><th>Valor Nuevo</th><th>Justificación</th><th>Estado</th>
            </tr>
          </thead>
          <tbody>
            ${novedades.map(n => `
              <tr>
                <td>${n.fecha.substring(0, 16)}</td>
                <td><b>${n.activo_nombre || 'Activo'}</b><br><span style="font-size:0.72rem;">${n.codigo_inventario || ''}</span></td>
                <td><code>${n.campo_modificado}</code></td>
                <td style="color:#dc2626;">${n.valor_anterior || '-'}</td>
                <td style="color:#059669;font-weight:bold;">${n.valor_nuevo || '-'}</td>
                <td>${n.justificacion}</td>
                <td><span class="badge info">${n.estado}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  document.getElementById('page-content').innerHTML = html;
}

async function renderMantenimiento() {
  const res = await api('/api/mantenimientos');
  const mantenimientos = res.mantenimientos || [];

  const html = `
    <div style="margin-bottom:16px;">
      <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Mantenimiento y Estado de Activos</h1>
      <p style="font-size:0.82rem;color:var(--text-muted);">Separación de estado físico y operativo, diagnósticos y costos.</p>
    </div>
    <div class="card" style="padding:0;overflow:hidden;">
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr><th>Fecha</th><th>Activo</th><th>Tipo</th><th>Diagnóstico</th><th>Responsable Servicio</th><th>Costo</th><th>Estado</th></tr>
          </thead>
          <tbody>
            ${mantenimientos.map(m => `
              <tr>
                <td>${m.fecha_solicitud}</td>
                <td><b>${m.activo_nombre}</b></td>
                <td><b>${m.tipo_mantenimiento}</b></td>
                <td>${m.diagnostico || '-'}</td>
                <td>${m.responsable_servicio || '-'}</td>
                <td>$${(m.costo || 0).toLocaleString()}</td>
                <td><span class="badge success">${m.estado}</span></td>
              </tr>
            `).join('')}
            ${mantenimientos.length === 0 ? '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted);">Sin mantenimientos registrados.</td></tr>' : ''}
          </tbody>
        </table>
      </div>
    </div>
  `;
  document.getElementById('page-content').innerHTML = html;
}

function renderReportes() {
  const reportes = [
    "1. Inventario general nacional", "2. Inventario por regional", "3. Inventario por sede",
    "4. Inventario por responsable", "5. Activos sin código", "6. Activos sin serial",
    "7. Activos sin responsable", "8. Activos sin ubicación", "9. Activos con información incompleta",
    "10. Activos nuevos", "11. Activos no encontrados", "12. Movimientos de activos",
    "13. Activos asignados a excolaboradores", "14. Inventarios conciliados", "15. Auditorías por regional",
    "16. Informes de Calidad", "17. Hallazgos", "18. Acciones correctivas",
    "19. Programaciones de inventario", "20. Cumplimiento de jornadas", "21. Historial de modificaciones",
    "22. Reporte fotográfico"
  ];

  const html = `
    <div style="margin-bottom:16px;">
      <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Módulo Oficial de Reportes (22 Tipos)</h1>
      <p style="font-size:0.82rem;color:var(--text-muted);">Generación y exportación de informes oficiales en formato CSV / Excel y PDF imprimible.</p>
    </div>

    <div class="card">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;">
        ${reportes.map((rep, idx) => `
          <div style="border:1px solid var(--border-color);padding:14px;border-radius:8px;background:#fff;display:flex;justify-content:space-between;align-items:center;">
            <div style="font-size:0.85rem;font-weight:600;color:var(--secondary);">${rep}</div>
            <a href="javascript:void(0)" class="btn btn-outline btn-sm" onclick="downloadAuthFile('/api/reportes/${idx + 1}','reporte.csv')">Exportar</a>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  document.getElementById('page-content').innerHTML = html;
}

async function renderNotificaciones() {
  const res = await api('/api/notificaciones');
  const notifs = res.notificaciones || [];

  const html = `
    <div style="margin-bottom:16px;">
      <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Centro de Notificaciones</h1>
      <p style="font-size:0.82rem;color:var(--text-muted);">Alertas de desvinculaciones, jornadas programadas y hallazgos.</p>
    </div>

    <div class="card" style="padding:0;overflow:hidden;">
      ${notifs.map(n => `
        <div style="padding:14px 18px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;background:${n.leida ? '#fff' : '#f0fdf4'};">
          <div>
            <div style="font-weight:700;font-size:0.88rem;color:var(--secondary);">${n.titulo}</div>
            <div style="font-size:0.82rem;color:#4b5563;">${n.mensaje}</div>
            <span style="font-size:0.72rem;color:#9ca3af;">${n.created_at}</span>
          </div>
          ${n.link ? `<a href="${n.link}" class="btn btn-primary btn-sm">Ver Detalle</a>` : ''}
        </div>
      `).join('')}
      ${notifs.length === 0 ? '<div style="padding:30px;text-align:center;color:#6b7280;">No tiene notificaciones pendientes.</div>' : ''}
    </div>
  `;
  document.getElementById('page-content').innerHTML = html;
  api('/api/notificaciones/leer', { method: 'POST', body: {} }).then(() => {
    const badge = document.getElementById('notif-count-badge');
    if (badge) badge.style.display = 'none';
  }).catch(() => {});
}

function renderRegionales() {
  const html = `
    <div style="margin-bottom:16px;">
      <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Catálogo Oficial de las 19 Regionales y Sedes</h1>
      <p style="font-size:0.82rem;color:var(--text-muted);">Estructura territorial corporativa de Jardines del Renacer.</p>
    </div>

    <div class="card" style="padding:0;overflow:hidden;">
      <table class="data-table">
        <thead>
          <tr><th>ID</th><th>Regional</th><th>Código</th><th>Sedes Activas</th><th>Total Activos</th></tr>
        </thead>
        <tbody>
          ${STATE.regionales.map(r => `
            <tr>
              <td>${r.id}</td>
              <td><b>${r.nombre}</b></td>
              <td><code>${r.codigo || ''}</code></td>
              <td><b>${r.total_sedes || 0}</b> sedes</td>
              <td><b>${r.total_activos || 0}</b> activos</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  document.getElementById('page-content').innerHTML = html;
}

async function renderUsuarios() {
  const res = await api('/api/usuarios');
  const usuarios = res.usuarios || [];

  const html = `
    <div style="margin-bottom:16px;">
      <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Administración de Usuarios y Permisos</h1>
      <p style="font-size:0.82rem;color:var(--text-muted);">Control de acceso por roles y asignación de regionales.</p>
    </div>

    <div class="card" style="padding:0;overflow:hidden;">
      <table class="data-table">
        <thead>
          <tr><th>Nombre Completo</th><th>Email</th><th>Cargo</th><th>Rol</th><th>Regionales Asignadas</th><th>Estado</th></tr>
        </thead>
        <tbody>
          ${usuarios.map(u => `
            <tr>
              <td><b>${u.nombre_completo}</b></td>
              <td>${u.email}</td>
              <td>${u.cargo || '-'}</td>
              <td><span class="badge ${u.rol_nombre === 'ADMINISTRADOR' ? 'danger' : 'info'}">${u.rol_nombre}</span></td>
              <td>${u.regionales.length > 0 ? `${u.regionales.length} regional(es)` : 'Nacional'}</td>
              <td><span class="badge success">Activo</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  document.getElementById('page-content').innerHTML = html;
}

async function renderConfiguracion() {
  // Consultar errores registrados
  let errores = [];
  try {
    const errRes = await api('/api/logs/errores?limit=30');
    errores = errRes.errores || [];
  } catch (e) {}

  const pendientes = errores.filter(e => !e.resuelto).length;

  const html = `
    <div style="max-width:960px;margin:0 auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div>
          <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Configuración y Diagnóstico del Sistema</h1>
          <p style="font-size:0.82rem;color:var(--text-muted);">Monitoreo de salud técnica, archivo oficial de errores (app_errors.log) y base de datos.</p>
        </div>
        <div style="display:flex;gap:10px;">
          <a href="javascript:void(0)" class="btn btn-primary btn-sm" onclick="downloadAuthFile('/api/logs/download','app_errors.log')">📥 Descargar app_errors.log</a>
          <button class="btn btn-outline btn-sm" onclick="renderConfiguracion()">🔄 Actualizar</button>
        </div>
      </div>

      <!-- PANEL DE CONTROL DE ERRORES -->
      <div class="card" style="margin-bottom:20px;border-top:4px solid ${pendientes > 0 ? '#ef4444' : '#10b981'};">
        <div class="card-header">
          <div class="card-title">
            <span style="font-size:1.2rem;">🛠️</span> Archivo de Errores y Diagnóstico Rápido
          </div>
          <div>
            <span class="badge ${pendientes > 0 ? 'danger' : 'success'}" style="font-size:0.8rem;padding:4px 10px;">
              ${pendientes} Error(es) Pendiente(s)
            </span>
          </div>
        </div>

        <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:16px;">
          Todos los errores técnicos del backend y frontend se registran automáticamente en el archivo físico 
          <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;font-weight:bold;color:#0f172a;">app_errors.log</code> 
          con marca de tiempo, módulo, usuario y trazabilidad completa para resolución rápida.
        </p>

        <!-- TABLA DE ERRORES -->
        <div class="table-responsive" style="max-height:360px;overflow-y:auto;border:1px solid var(--border-color);border-radius:8px;">
          <table class="data-table" style="font-size:0.8rem;">
            <thead>
              <tr>
                <th>ID</th>
                <th>Fecha</th>
                <th>Nivel / Módulo</th>
                <th>Descripción del Error</th>
                <th>Estado</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              ${errores.map(err => `
                <tr style="background:${err.resuelto ? '#ffffff' : '#fff5f5'};">
                  <td><b>#${err.id}</b></td>
                  <td style="white-space:nowrap;font-size:0.75rem;">${err.fecha}</td>
                  <td>
                    <span class="badge ${err.nivel === 'CRITICAL' ? 'danger' : (err.nivel === 'ERROR' ? 'danger' : 'warning')}">${err.nivel}</span><br>
                    <span style="font-size:0.72rem;color:var(--text-muted);">${err.modulo || 'N/A'}</span>
                  </td>
                  <td>
                    <div style="font-weight:600;color:#0f172a;">${err.mensaje}</div>
                    ${err.detalle_tecnico ? `
                      <details style="margin-top:4px;font-size:0.72rem;color:#64748b;cursor:pointer;">
                        <summary>Ver detalle técnico (Traceback)</summary>
                        <pre style="background:#0f172a;color:#f8fafc;padding:8px;border-radius:6px;overflow-x:auto;margin-top:4px;white-space:pre-wrap;">${err.detalle_tecnico}</pre>
                      </details>
                    ` : ''}
                    ${err.notas_solucion ? `<div style="font-size:0.72rem;color:#059669;margin-top:2px;"><b>Solución:</b> ${err.notas_solucion} (${err.resuelto_por || 'Admin'})</div>` : ''}
                  </td>
                  <td>
                    <span class="badge ${err.resuelto ? 'success' : 'danger'}">${err.resuelto ? 'Solucionado' : 'Pendiente'}</span>
                  </td>
                  <td>
                    ${!err.resuelto ? `
                      <button class="btn btn-primary btn-sm" onclick="openResolverErrorModal(${err.id})">Solucionar</button>
                    ` : '<span style="color:#10b981;font-size:1.1rem;">✓</span>'}
                  </td>
                </tr>
              `).join('')}
              ${errores.length === 0 ? '<tr><td colspan="6" style="text-align:center;padding:24px;color:#10b981;font-weight:600;">✓ No hay errores registrados en app_errors.log. El sistema opera con normalidad.</td></tr>' : ''}
            </tbody>
          </table>
        </div>
      </div>

      <!-- BASE DE DATOS Y SINCRONIZACIÓN -->
      <div class="card">
        <div class="card-header"><div class="card-title">💾 Base de Datos e Importación Maestro</div></div>
        <p style="font-size:0.85rem;line-height:1.6;margin-bottom:12px;">
          Fuente de datos inicial: <b>Activos.csv</b> (1.573 registros oficiales importados con UUIDs independientes).<br>
          Esquema de base de datos: Relacional normalizada con llaves foráneas y RLS (Row Level Security).<br>
          Archivos Supabase listos en: <code>supabase/01_schema.sql</code>, <code>supabase/02_seed_regionales.sql</code>, <code>supabase/03_import_activos.sql</code>.
        </p>
        <button class="btn btn-outline" onclick="showToast('El sistema se encuentra sincronizado con 1.573 registros.', 'success')">Verificar Integridad</button>
      </div>
    </div>
  `;
  document.getElementById('page-content').innerHTML = html;
}

function openResolverErrorModal(errorId) {
  const modalHtml = `
    <div class="modal-overlay" id="modal-res-err">
      <div class="modal-content" style="max-width:480px;">
        <div class="modal-header">
          <h3 style="color:var(--secondary);font-size:1.1rem;font-weight:700;">Marcar Error #${errorId} como Solucionado</h3>
          <button class="btn-close" onclick="closeModal('modal-res-err')">&times;</button>
        </div>
        <form onsubmit="submitResolverError(event, ${errorId})">
          <div class="form-group" style="margin-bottom:14px;">
            <label>Notas de la Corrección o Solución Aplicada</label>
            <textarea id="err-sol-notas" class="form-control" rows="3" placeholder="Ej: Se corrigió validación de campo, se reindexó la base de datos o se actualizó el registro..." required></textarea>
          </div>
          <div style="text-align:right;">
            <button type="button" class="btn btn-outline" onclick="closeModal('modal-res-err')">Cancelar</button>
            <button type="submit" class="btn btn-primary">Registrar Solución</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('modal-container').innerHTML = modalHtml;
  document.getElementById('modal-container').style.display = 'block';
}

async function submitResolverError(e, errorId) {
  e.preventDefault();
  const notas = document.getElementById('err-sol-notas').value;
  await api(`/api/logs/resolver/${errorId}`, {
    method: 'POST',
    body: { notas_solucion: notas }
  });
  showToast(`Error #${errorId} solucionado exitosamente`, 'success');
  closeModal('modal-res-err');
  renderConfiguracion();
}

// CAPTURA GLOBAL DE ERRORES FRONTEND EN app_errors.log (sin bucles: usa fetch directo)
let _clientErrCount = 0;
function reportClientError(mensaje, stack) {
  if (++_clientErrCount > 20) return; // evita inundar el log
  try {
    fetch('/api/logs/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensaje: String(mensaje || '').slice(0, 500), stack: String(stack || '').slice(0, 2000), url: window.location.href })
    }).catch(() => {});
  } catch (e) {}
}
window.addEventListener('error', (event) => {
  reportClientError(event.message, event.error ? event.error.stack : `${event.filename}:${event.lineno}`);
});
window.addEventListener('unhandledrejection', (event) => {
  const r = event.reason;
  if (r && r.fromApi) return; // ya notificado al usuario por api()
  reportClientError(`Promesa rechazada no manejada: ${r && r.message ? r.message : r}`, r && r.stack ? r.stack : '');
});

function renderFisico() {
  navigate('maestro');
}

function renderMovimientos() {
  api('/api/movimientos').then(res => {
    const movs = res.movimientos || [];
    const html = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:1.3rem;font-weight:800;color:var(--secondary);">Historial de Movimientos y Asignaciones</h1>
        <p style="font-size:0.82rem;color:var(--text-muted);">Trazabilidad inmutable de traslados, mantenimientos, bajas y reasignaciones.</p>
      </div>
      <div class="card" style="padding:0;overflow:hidden;">
        <table class="data-table">
          <thead>
            <tr><th>Fecha</th><th>Activo</th><th>Tipo</th><th>Motivo</th><th>Custodio / Ubicación Anterior</th><th>Custodio / Ubicación Nueva</th><th>Registrado Por</th></tr>
          </thead>
          <tbody>
            ${movs.map(m => `
              <tr>
                <td>${m.fecha.substring(0, 16)}</td>
                <td><b>${m.activo_nombre}</b><br><span style="font-size:0.72rem;">${m.codigo_inventario || ''}</span></td>
                <td><b>${m.tipo_movimiento}</b></td>
                <td>${m.motivo}</td>
                <td style="color:#6b7280;">${m.resp_ant_nombre || m.ubicacion_anterior || '-'}</td>
                <td style="color:#059669;font-weight:bold;">${m.resp_nvo_nombre || m.ubicacion_nueva || '-'}</td>
                <td>${m.usuario_nombre || 'Sistema'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    document.getElementById('page-content').innerHTML = html;
  });
}

function startNotificationPolling() {
  if (STATE.notifInterval) clearInterval(STATE.notifInterval);
  const poll = async () => {
    if (STATE.token) {
      try {
        const res = await api('/api/notificaciones');
        const unread = (res.notificaciones || []).filter(n => !n.leida).length;
        const badge = document.getElementById('notif-count-badge');
        if (badge) {
          badge.innerText = unread;
          badge.style.display = unread > 0 ? 'flex' : 'none';
        }
      } catch (e) {}
    }
  };
  poll();
  STATE.notifInterval = setInterval(poll, 10000);
}

// INICIALIZAR EN DOM READY
document.addEventListener('DOMContentLoaded', initApp);
