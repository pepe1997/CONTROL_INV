const CONFIG = {
  SHEET_ID: "1-v6vXjHpLlIn0-_lVZw0BtGopnxSHH0zqoOrW8aBwcg",
  DEFAULT_API_URL: "https://script.google.com/macros/s/AKfycbyDIkA9grHHVGMEY5-R_qYpiYxY4XId_7ckrfEMs_adwFR7vHhPd2QtB6gjopZgK3BA0Q/exec",
  API_STORAGE_KEY: "anc_inv_activo_api_url",
  VALIDACIONES_KEY: "anc_inv_activo_validaciones_v1",
  PENDING_SYNC_KEY: "anc_inv_activo_sync_pendiente_v1",
  LOCAL_RESET_AT_KEY: "anc_inv_activo_reset_at_v1",
  DATA_CACHE_KEY: "anc_inv_activo_data_v1",
  SESSION_KEY: "anc_inv_activo_sesion_v1",
  PASILLO_EXCLUIDO: "10",
  POLL_MS: 12000
};

const app = document.getElementById("app");
const canal = "BroadcastChannel" in window ? new BroadcastChannel("anc_inv_activo") : null;
let inventario = [];
let productos = [];
let productosIndex = new Map();
let ubicaciones = [];
let validaciones = {};
let pasilloActivo = "01";
let filtroTexto = "";
let cargando = false;
let sesion = leerSesion();
let monitorPasilloActivo = "";
let modalCantidad = null;
let avisoGuardado = "";
let syncTimer = null;
let filtroTimer = null;
let mantenerFocoBusqueda = false;
let dashboardModoReporte = false;
const ESTADO_GESTION_DEFAULT = "PENDIENTE";

const USUARIOS = {
  celular: { pass: "1234", nombre: "Validador", vista: "mobile" },
  admin: { pass: "Spsa1997", nombre: "Administrador", vista: "monitor" }
};

function limpiar(valor) {
  if (valor === null || valor === undefined) return "";
  return String(valor).trim();
}

function normalizar(valor) {
  return limpiar(valor).replace(/'/g, "").replace(/\.0$/, "").replace(/\s/g, "").toUpperCase();
}

function html(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function num(valor) {
  const n = parseFloat(String(valor || "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function fmt(valor) {
  return Number(valor || 0).toLocaleString("es-PE", { maximumFractionDigits: 2 });
}

function excelTexto(valor) {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function campo(row, nombres) {
  for (const nombre of nombres) {
    if (row[nombre] !== undefined && row[nombre] !== null && row[nombre] !== "") return row[nombre];
  }
  return "";
}

function prepararIndiceProductos() {
  productosIndex = new Map();
  productos.forEach(producto => {
    const codigo = normalizar(campo(producto, ["CODIGO", "Codigo", "PRODUCTO", "Producto"]));
    if (codigo && !productosIndex.has(codigo)) productosIndex.set(codigo, producto);
  });
}

function apiUrl() {
  return limpiar(localStorage.getItem(CONFIG.API_STORAGE_KEY)) || limpiar(CONFIG.DEFAULT_API_URL);
}

function leerSesion() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG.SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function guardarSesion(data) {
  sesion = data;
  localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(data));
}

function cerrarSesion() {
  sesion = null;
  localStorage.removeItem(CONFIG.SESSION_KEY);
  renderLogin();
}

async function reiniciarAvance() {
  const ok = window.confirm("Esto borrara todos los avances guardados en Google Sheet y en este equipo. Deseas reiniciar desde cero?");
  if (!ok) return;
  mostrarAviso("Reiniciando avance...");
  const resetAt = new Date().toISOString();
  localStorage.setItem(CONFIG.LOCAL_RESET_AT_KEY, resetAt);
  validaciones = {};
  localStorage.removeItem(CONFIG.VALIDACIONES_KEY);
  localStorage.removeItem(CONFIG.PENDING_SYNC_KEY);
  canal?.postMessage({ tipo: "validaciones", validaciones });
  render();
  try {
    await apiPost({ action: "reset", resetAt });
    mostrarAviso("Avance reiniciado correctamente.");
    render();
  } catch (error) {
    mostrarAviso("Avance local reiniciado. Falta actualizar Apps Script para borrar Google Sheet.");
    render();
  }
}

function login(event) {
  event?.preventDefault();
  const user = limpiar(document.getElementById("loginUser")?.value).toLowerCase();
  const pass = limpiar(document.getElementById("loginPass")?.value);
  const perfil = USUARIOS[user];
  if (!perfil || perfil.pass !== pass) {
    const error = document.getElementById("loginError");
    if (error) error.textContent = "Usuario o clave incorrecta.";
    return;
  }
  guardarSesion({ user, nombre: perfil.nombre, vista: perfil.vista });
  const url = new URL(location.href);
  url.searchParams.set("view", perfil.vista);
  history.replaceState(null, "", url);
  leerValidacionesLocales();
  if (leerCacheData()) render();
  else renderCarga("Entrando...");
  cargarDatos();
}

async function hoja(nombre) {
  const url = `https://opensheet.elk.sh/${CONFIG.SHEET_ID}/${encodeURIComponent(nombre)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`No se pudo cargar ${nombre}`);
  return res.json();
}

function parseUbicacion(ubicacion) {
  const partes = limpiar(ubicacion).toUpperCase().split("-");
  if (partes[0] !== "MASS" || !partes[1]) return null;
  const pasillo = limpiar(partes[1]).padStart(2, "0");
  const bahia = limpiar(partes[2] || "00").padStart(2, "0");
  return { pasillo, bahia, orden: partes.slice(1).map(x => num(x)) };
}

function compararUbicacion(a, b) {
  const pa = parseUbicacion(a) || { orden: [999, 999, 999, 999] };
  const pb = parseUbicacion(b) || { orden: [999, 999, 999, 999] };
  for (let i = 0; i < 4; i += 1) {
    const dif = (pa.orden[i] || 0) - (pb.orden[i] || 0);
    if (dif) return dif;
  }
  return limpiar(a).localeCompare(limpiar(b));
}

function productoInfo(codigo, row = {}) {
  const cod = normalizar(codigo);
  const producto = productosIndex.get(cod);
  return {
    codigo: cod,
    codAlt: limpiar(campo(row, ["COD_ALT", "CODIGO_ALT", "CODIGO ALTERNATIVO", "Cod Alternat"])) || limpiar(campo(producto || {}, ["CODIGO_ALT", "COD_ALT", "CODIGO ALTERNATIVO", "Cod Alternat"])),
    estilo: limpiar(campo(row, ["ESTILO", "Estilo", "STYLE", "MODELO"])) || limpiar(campo(producto || {}, ["ESTILO", "Estilo", "STYLE", "MODELO"])),
    descripcion: limpiar(campo(row, ["DESCRIPCION", "Descripcion", "Descripción"])) || limpiar(campo(producto || {}, ["DESCRIPCION", "Descripcion", "Descripción"])),
    uxb: num(campo(row, ["UXB", "Uxb", "UNID_CAJA", "UND_CAJA"])) || num(campo(producto || {}, ["UXB", "Uxb", "UNID_CAJA", "UND_CAJA"])) || 1
  };
}

function consolidarInventario(rows) {
  const mapa = new Map();
  rows.forEach(row => {
    const codigo = normalizar(campo(row, ["PRODUCTO", "CODIGO", "Codigo"]));
    const ubicacion = limpiar(campo(row, ["UBICACION", "Ubicacion", "Ubicación"]));
    const partes = parseUbicacion(ubicacion);
    if (!codigo || !ubicacion || !partes || partes.pasillo === CONFIG.PASILLO_EXCLUIDO) return;
    const info = productoInfo(codigo, row);
    const unidades = num(campo(row, ["UNACT", "UnAct", "UN ACT", "UNIDADES"]));
    const asignadas = num(campo(row, ["UNI_ASIG", "UN_ASIG", "Un Asig", "UN ASIG", "UNIDADES ASIGNADAS"]));
    const transitoUnd = num(campo(row, ["En las Unidades de TrÃ¡nsito", "En las Unidades de Tránsito", "TRANSITO", "Transito", "UN_TRANSITO", "UN TRANSITO"]));
    const bultos = info.uxb ? unidades / info.uxb : unidades;
    const transitoBultos = info.uxb ? transitoUnd / info.uxb : transitoUnd;
    const key = normalizar(ubicacion);
    if (!mapa.has(key)) {
      mapa.set(key, {
        id: key,
        ubicacion,
        pasillo: partes.pasillo,
        bahia: partes.bahia,
        uxb: info.uxb,
        unidades: 0,
        asignadas: 0,
        transitoUnd: 0,
        bultos: 0,
        transitoBultos: 0,
        filas: 0,
        productos: new Map()
      });
    }
    const item = mapa.get(key);
    item.unidades += unidades;
    item.asignadas += asignadas;
    item.transitoUnd += transitoUnd;
    item.bultos += bultos;
    item.transitoBultos += transitoBultos;
    item.filas += 1;
    if (!item.productos.has(codigo)) {
      item.productos.set(codigo, {
        codigo,
        codAlt: info.codAlt,
        estilo: info.estilo,
        descripcion: info.descripcion,
        uxb: info.uxb,
        unidades: 0,
        asignadas: 0,
        transitoUnd: 0,
        bultos: 0,
        transitoBultos: 0
      });
    }
    const prod = item.productos.get(codigo);
    prod.unidades += unidades;
    prod.asignadas += asignadas;
    prod.transitoUnd += transitoUnd;
    prod.bultos += bultos;
    prod.transitoBultos += transitoBultos;
  });
  return Array.from(mapa.values()).map(item => {
    const productosDetalle = Array.from(item.productos.values())
      .sort((a, b) => b.bultos - a.bultos || a.codigo.localeCompare(b.codigo));
    const principal = productosDetalle[0] || {};
    const codigos = productosDetalle.map(p => p.codigo).filter(Boolean);
    const estilos = productosDetalle.map(p => p.estilo).filter(Boolean);
    return {
      ...item,
      productos: undefined,
      productosDetalle,
      productosTotal: productosDetalle.length,
      codigo: codigos.join(" / "),
      codAlt: productosDetalle.map(p => p.codAlt).filter(Boolean).join(" / "),
      estilo: estilos.join(" / "),
      descripcion: productosDetalle.length > 1
        ? `${productosDetalle.length} productos compartidos`
        : (principal.descripcion || ""),
      uxb: principal.uxb || item.uxb || 1
    };
  }).sort((a, b) => compararUbicacion(a.ubicacion, b.ubicacion) || String(a.codigo).localeCompare(String(b.codigo)));
}

function guardarCacheData() {
  localStorage.setItem(CONFIG.DATA_CACHE_KEY, JSON.stringify({
    inventario,
    productos,
    guardado: new Date().toISOString()
  }));
}

function leerCacheData() {
  try {
    const data = JSON.parse(localStorage.getItem(CONFIG.DATA_CACHE_KEY) || "null");
    if (!data?.inventario?.length) return false;
    inventario = data.inventario;
    productos = data.productos || [];
    prepararIndiceProductos();
    ubicaciones = consolidarInventario(inventario);
    return true;
  } catch {
    return false;
  }
}

function guardarValidaciones() {
  localStorage.setItem(CONFIG.VALIDACIONES_KEY, JSON.stringify(validaciones));
  canal?.postMessage({ tipo: "validaciones", validaciones });
}

function leerPendientesSync() {
  try {
    const data = JSON.parse(localStorage.getItem(CONFIG.PENDING_SYNC_KEY) || "[]");
    return Array.isArray(data) ? data.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function guardarPendientesSync(ids) {
  localStorage.setItem(CONFIG.PENDING_SYNC_KEY, JSON.stringify(Array.from(new Set(ids.filter(Boolean)))));
}

function agregarPendienteSync(id) {
  guardarPendientesSync([...leerPendientesSync(), id]);
}

function quitarPendientesSync(ids) {
  const removidos = new Set(ids);
  guardarPendientesSync(leerPendientesSync().filter(id => !removidos.has(id)));
}

function programarSync(ms = 700) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    sincronizarValidacionesLocales().catch(() => {});
  }, ms);
}

function mostrarAviso(texto) {
  avisoGuardado = texto;
  clearTimeout(mostrarAviso.timer);
  mostrarAviso.timer = setTimeout(() => {
    avisoGuardado = "";
    render();
  }, 2200);
}

function aplicarCorteReset(registros) {
  const resetAt = localStorage.getItem(CONFIG.LOCAL_RESET_AT_KEY);
  if (!resetAt) return registros || {};
  const corte = Date.parse(resetAt);
  if (!Number.isFinite(corte)) return registros || {};
  return Object.fromEntries(Object.entries(registros || {}).filter(([, row]) => {
    const fecha = Date.parse(row?.actualizado || "");
    return Number.isFinite(fecha) && fecha >= corte;
  }));
}

function leerValidacionesLocales() {
  try {
    validaciones = aplicarCorteReset(JSON.parse(localStorage.getItem(CONFIG.VALIDACIONES_KEY) || "{}") || {});
  } catch {
    validaciones = {};
  }
}

function fechaMs(valor) {
  const fecha = Date.parse(valor || "");
  return Number.isFinite(fecha) ? fecha : 0;
}

function combinarValidaciones(remotas = {}) {
  const remote = aplicarCorteReset(remotas || {});
  const local = aplicarCorteReset(validaciones || {});
  const pendientes = new Set(leerPendientesSync());
  const merged = { ...remote };
  Object.entries(local).forEach(([id, registroLocal]) => {
    const registroRemoto = remote[id];
    if (
      pendientes.has(id) ||
      !registroRemoto ||
      fechaMs(registroLocal?.actualizado) >= fechaMs(registroRemoto?.actualizado)
    ) {
      merged[id] = registroLocal;
    }
  });
  return merged;
}

async function apiGet(params = {}) {
  const urlBase = apiUrl();
  if (!urlBase) return null;
  const url = new URL(urlBase);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("_", Date.now());
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();
  if (data.ok === false) throw new Error(data.mensaje || "Error API");
  return data;
}

async function apiPost(payload) {
  const urlBase = apiUrl();
  if (!urlBase) return null;
  const res = await fetch(urlBase, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
    redirect: "follow"
  });
  const data = await res.json();
  if (data.ok === false) throw new Error(data.mensaje || "Error API");
  return data;
}

async function cargarValidaciones() {
  leerValidacionesLocales();
  try {
    await sincronizarValidacionesLocales();
    const data = await apiGet({ action: "validaciones" });
    if (data?.validaciones) {
      validaciones = combinarValidaciones(data.validaciones);
      guardarValidaciones();
    }
  } catch {}
}

async function sincronizarValidacionesLocales() {
  if (!apiUrl()) return;
  const pendientes = leerPendientesSync();
  if (!pendientes.length) return;
  const registros = pendientes.map(id => validaciones[id]).filter(v => v && v.id && v.estado);
  if (!registros.length) {
    quitarPendientesSync(pendientes);
    return;
  }
  const resultados = await Promise.allSettled(registros.map(registro => apiPost({ action: "guardar", registro })));
  quitarPendientesSync(registros.filter((_, index) => resultados[index].status === "fulfilled").map(v => v.id));
}

async function cargarDatos(forzar = false) {
  if (cargando) return;
  cargando = true;
  const tieneVista = ubicaciones.length > 0;
  if (!tieneVista) renderCarga("Cargando inventario activo...");
  try {
    if (!forzar && leerCacheData()) {
      leerValidacionesLocales();
      render();
      setTimeout(() => cargarValidaciones().then(render).catch(() => {}), 50);
      setTimeout(() => cargarDatos(true), 250);
      return;
    }
    const [inv, prod] = await Promise.all([hoja("INV_ACTIVO"), hoja("PRODUCTOS")]);
    inventario = inv;
    productos = prod;
    prepararIndiceProductos();
    ubicaciones = consolidarInventario(inv);
    guardarCacheData();
    leerValidacionesLocales();
    render();
    await cargarValidaciones();
    render();
  } catch (error) {
    if (tieneVista) {
      mostrarAviso("No se pudo actualizar ahora. Se mantiene la data cargada.");
      render();
    } else {
      renderError(error);
    }
  } finally {
    cargando = false;
  }
}

function resumen() {
  const total = ubicaciones.length;
  const vals = ubicaciones.map(validacionConInventario);
  const ok = vals.filter(v => v.estado === "OK").length;
  const falta = vals.filter(v => v.estado === "FALTA").length;
  const sobra = vals.filter(v => v.estado === "SOBRA").length;
  const pendiente = Math.max(0, total - ok - falta - sobra);
  return { total, ok, falta, sobra, pendiente };
}

function estadoItem(item) {
  return validaciones[item.id]?.estado || "PENDIENTE";
}

function validacionConInventario(item) {
  const v = validaciones[item.id] || {};
  return {
    ...item,
    ...v,
    id: item.id,
    ubicacion: item.ubicacion,
    pasillo: item.pasillo,
    bahia: item.bahia,
    codigo: item.codigo,
    codAlt: item.codAlt,
    estilo: item.estilo,
    descripcion: item.descripcion,
    productosTotal: item.productosTotal || 1,
    productosDetalle: item.productosDetalle || [],
    bultos: item.bultos,
    unidades: item.unidades,
    asignadas: item.asignadas,
    transitoUnd: item.transitoUnd,
    transitoBultos: item.transitoBultos,
    estado: v.estado || "PENDIENTE",
    observacion: v.observacion || "",
    diferenciaBultos: num(v.diferenciaBultos),
    diferenciaUnidades: num(v.diferenciaUnidades),
    tipoDiferencia: limpiar(v.tipoDiferencia),
    estadoGestion: normalizar(v.estadoGestion || ESTADO_GESTION_DEFAULT),
    actualizado: v.actualizado || ""
  };
}

function claseEstado(estado) {
  return estado === "OK" ? "ok" : estado === "FALTA" ? "falta" : estado === "SOBRA" ? "sobra" : "";
}

function stockFinalBultos(row) {
  const base = Number(row.bultos || 0);
  const diferencia = Number(row.diferenciaBultos || 0);
  if (row.estado === "FALTA") return Math.max(0, base - diferencia);
  if (row.estado === "SOBRA") return base + diferencia;
  return base;
}

function stockFinalUnidades(row) {
  const base = Number(row.unidades || 0);
  const diferencia = Number(row.diferenciaUnidades || 0);
  if (row.estado === "FALTA") return Math.max(0, base - diferencia);
  if (row.estado === "SOBRA") return base + diferencia;
  return base;
}

function validacionIncidenciaHtml(row) {
  const signo = row.estado === "FALTA" ? "-" : "+";
  const clase = row.estado === "FALTA" ? "falta" : "sobra";
  return `
    <div class="validation-mini ${clase}">
      <div><span>Sistema</span><strong>${fmt(row.bultos || 0)}</strong><em>bul</em></div>
      <b>${signo}</b>
      <div><span>${row.estado === "FALTA" ? "Falta" : "Sobra"}</span><strong>${fmt(row.diferenciaBultos || 0)}</strong><em>bul</em></div>
      <b>=</b>
      <div><span>Final</span><strong>${fmt(stockFinalBultos(row))}</strong><em>bul</em></div>
      <small>${fmt(row.unidades || 0)} und sistema | ${fmt(stockFinalUnidades(row))} und final</small>
    </div>
  `;
}

function etiquetaProductoUbicacion(item) {
  if (Number(item.productosTotal || 0) <= 1) {
    return `${html(item.codigo)}${item.estilo ? ` | ${html(item.estilo)}` : ""}`;
  }
  const codigos = (item.productosDetalle || []).slice(0, 3).map(p => p.codigo).join(" / ");
  const resto = item.productosTotal > 3 ? ` +${item.productosTotal - 3}` : "";
  return `${fmt(item.productosTotal)} productos compartidos${codigos ? ` | ${html(codigos)}${resto}` : ""}`;
}

async function marcar(id, estado, observacion = null, extras = {}) {
  const item = ubicaciones.find(u => u.id === id);
  if (!item) return;
  const actual = validaciones[id] || {};
  const registro = {
    ...actual,
    id,
    estado,
    observacion: observacion === null ? (actual.observacion || "") : observacion,
    ubicacion: item.ubicacion,
    pasillo: item.pasillo,
    bahia: item.bahia,
    codigo: item.codigo,
    codAlt: item.codAlt,
    estilo: item.estilo,
    descripcion: item.descripcion,
    productosTotal: item.productosTotal || 1,
    productosDetalle: item.productosDetalle || [],
    bultos: item.bultos,
    unidades: item.unidades,
    asignadas: item.asignadas,
    transitoUnd: item.transitoUnd,
    transitoBultos: item.transitoBultos,
    diferenciaBultos: estado === "OK" ? 0 : num(extras.diferenciaBultos ?? actual.diferenciaBultos),
    diferenciaUnidades: estado === "OK" ? 0 : num(extras.diferenciaUnidades ?? actual.diferenciaUnidades),
    tipoDiferencia: estado === "OK" ? "" : limpiar(extras.tipoDiferencia || actual.tipoDiferencia),
    estadoGestion: normalizar(actual.estadoGestion || ESTADO_GESTION_DEFAULT),
    actualizado: new Date().toISOString()
  };
  validaciones[id] = registro;
  guardarValidaciones();
  agregarPendienteSync(id);
  if (observacion === null) render();
  try {
    await apiPost({ action: "guardar", registro });
    quitarPendientesSync([id]);
  } catch {
    programarSync(1800);
  }
}

function registroValidacion(item, estado, observacion = "", extras = {}) {
  const actual = validaciones[item.id] || {};
  return {
    ...actual,
    id: item.id,
    estado,
    observacion,
    ubicacion: item.ubicacion,
    pasillo: item.pasillo,
    bahia: item.bahia,
    codigo: item.codigo,
    codAlt: item.codAlt,
    estilo: item.estilo,
    descripcion: item.descripcion,
    productosTotal: item.productosTotal || 1,
    productosDetalle: item.productosDetalle || [],
    bultos: item.bultos,
    unidades: item.unidades,
    asignadas: item.asignadas,
    transitoUnd: item.transitoUnd,
    transitoBultos: item.transitoBultos,
    diferenciaBultos: num(extras.diferenciaBultos ?? 0),
    diferenciaUnidades: num(extras.diferenciaUnidades ?? 0),
    tipoDiferencia: limpiar(extras.tipoDiferencia || ""),
    estadoGestion: normalizar(actual.estadoGestion || ESTADO_GESTION_DEFAULT),
    actualizado: new Date().toISOString()
  };
}

async function marcarTodoOkVisible() {
  const items = itemsFiltrados();
  if (!items.length) {
    mostrarAviso("No hay ubicaciones visibles para marcar.");
    return;
  }
  const ok = window.confirm(`Se marcaran ${items.length} ubicaciones visibles como OK. Luego podras cambiar las que tengan faltante o sobrante. Deseas continuar?`);
  if (!ok) return;
  const ids = [];
  items.forEach(item => {
    validaciones[item.id] = registroValidacion(item, "OK", validaciones[item.id]?.observacion || "");
    ids.push(item.id);
  });
  guardarValidaciones();
  guardarPendientesSync([...leerPendientesSync(), ...ids]);
  mostrarAviso(`${items.length} ubicaciones marcadas como OK.`);
  render();
  try {
    const resultados = await Promise.allSettled(ids.map(id => apiPost({ action: "guardar", registro: validaciones[id] })));
    quitarPendientesSync(ids.filter((_, index) => resultados[index].status === "fulfilled"));
  } catch {
    programarSync(1800);
  }
}

async function cambiarEstadoGestion(id, estadoGestion = "") {
  const item = ubicaciones.find(u => u.id === id);
  if (!item) return;
  const actual = validaciones[id] || {};
  const nuevoEstado = normalizar(estadoGestion || actual.estadoGestion) === "REGULARIZADO" ? "PENDIENTE" : "REGULARIZADO";
  const registro = {
    ...validacionConInventario(item),
    ...actual,
    estadoGestion: nuevoEstado,
    actualizado: new Date().toISOString()
  };
  validaciones[id] = registro;
  guardarValidaciones();
  agregarPendienteSync(id);
  mostrarAviso(`Incidencia ${nuevoEstado.toLowerCase()}.`);
  render();
  try {
    await apiPost({ action: "guardar", registro });
    quitarPendientesSync([id]);
  } catch {
    programarSync(1800);
  }
}

function abrirModalCantidad(id, estado) {
  const item = ubicaciones.find(u => u.id === id);
  if (!item) return;
  const actual = validaciones[id] || {};
  modalCantidad = {
    id,
    estado,
    bultos: actual.diferenciaBultos || "",
    unidades: actual.diferenciaUnidades || "",
    observacion: actual.observacion || ""
  };
  render();
}

function cerrarModalCantidad() {
  modalCantidad = null;
  render();
}

function guardarModalCantidad(event = null) {
  if (event) event.preventDefault();
  if (!modalCantidad) return;
  const bultos = num(document.getElementById("modalBultos")?.value);
  const unidades = num(document.getElementById("modalUnidades")?.value);
  const observacion = limpiar(document.getElementById("modalObs")?.value);
  const tipoDiferencia = bultos > 0 && unidades > 0 ? "BULTOS_UNIDADES" : bultos > 0 ? "BULTOS" : unidades > 0 ? "UNIDADES" : "";
  const { id, estado } = modalCantidad;
  modalCantidad = null;
  mostrarAviso(`${estado === "FALTA" ? "Falta" : "Sobra"} guardado correctamente`);
  marcar(id, estado, observacion, { diferenciaBultos: bultos, diferenciaUnidades: unidades, tipoDiferencia });
}

function cambiarObs(id, valor) {
  clearTimeout(cambiarObs.timer);
  const item = ubicaciones.find(u => u.id === id);
  if (!item) return;
  const actual = validaciones[id] || {};
  validaciones[id] = {
    ...actual,
    id,
    estado: actual.estado || "PENDIENTE",
    observacion: valor,
    ubicacion: item.ubicacion,
    pasillo: item.pasillo,
    bahia: item.bahia,
    codigo: item.codigo,
    codAlt: item.codAlt,
    estilo: item.estilo,
    descripcion: item.descripcion,
    productosTotal: item.productosTotal || 1,
    productosDetalle: item.productosDetalle || [],
    bultos: item.bultos,
    unidades: item.unidades,
    asignadas: item.asignadas,
    transitoUnd: item.transitoUnd,
    transitoBultos: item.transitoBultos,
    diferenciaBultos: actual.diferenciaBultos || 0,
    diferenciaUnidades: actual.diferenciaUnidades || 0,
    tipoDiferencia: actual.tipoDiferencia || "",
    estadoGestion: normalizar(actual.estadoGestion || ESTADO_GESTION_DEFAULT),
    actualizado: new Date().toISOString()
  };
  localStorage.setItem(CONFIG.VALIDACIONES_KEY, JSON.stringify(validaciones));
  agregarPendienteSync(id);
  cambiarObs.timer = setTimeout(() => {
    guardarValidaciones();
    apiPost({ action: "guardar", registro: validaciones[id] })
      .then(() => quitarPendientesSync([id]))
      .catch(() => programarSync(1800));
  }, 900);
}

function filasExportables(pasillo = "") {
  return ubicaciones
    .filter(item => !pasillo || item.pasillo === pasillo)
    .map(item => {
      const row = validacionConInventario(item);
      return {
        pasillo: item.pasillo,
        bahia: item.bahia,
        ubicacion: item.ubicacion,
        codigo: item.codigo,
        codAlt: item.codAlt,
        estilo: item.estilo,
        descripcion: item.descripcion,
        productosTotal: item.productosTotal || 1,
        productosDetalle: (item.productosDetalle || []).map(p => `${p.codigo} ${p.estilo || p.descripcion || ""} (${fmt(p.bultos)} bul)`).join(" | "),
        bultosSistema: item.bultos,
        unidadesSistema: item.unidades,
        asignadas: item.asignadas,
        transitoBultos: item.transitoBultos,
        estado: row.estado,
        diferenciaBultos: row.diferenciaBultos || 0,
        diferenciaUnidades: row.diferenciaUnidades || 0,
        bultosValidados: stockFinalBultos(row),
        unidadesValidadas: stockFinalUnidades(row),
        estadoGestion: row.estadoGestion || ESTADO_GESTION_DEFAULT,
        observacion: row.observacion,
        actualizado: row.actualizado || ""
      };
    }).sort((a, b) => compararUbicacion(a.ubicacion, b.ubicacion));
}

function descargarExcelInventario(pasillo = "") {
  const data = filasExportables(pasillo);
  const headers = [
    "PASILLO", "BAHIA", "UBICACION", "CODIGO", "COD_ALT", "ESTILO", "DESCRIPCION", "PRODUCTOS_UBICACION", "DETALLE_PRODUCTOS",
    "BULTOS_SISTEMA", "UNIDADES_SISTEMA", "ASIGNADAS", "TRANSITO_BULTOS", "ESTADO",
    "DIF_BULTOS", "DIF_UNIDADES", "BULTOS_VALIDADOS", "UNIDADES_VALIDADAS", "ESTADO_GESTION", "OBSERVACION", "ACTUALIZADO"
  ];
  const rows = data.map(r => `
    <tr>
      <td>${excelTexto(r.pasillo)}</td><td>${excelTexto(r.bahia)}</td><td>${excelTexto(r.ubicacion)}</td>
      <td style="mso-number-format:'\\@'">${excelTexto(r.codigo)}</td>
      <td style="mso-number-format:'\\@'">${excelTexto(r.codAlt)}</td>
      <td>${excelTexto(r.estilo)}</td><td>${excelTexto(r.descripcion)}</td>
      <td>${Number(r.productosTotal || 1)}</td><td>${excelTexto(r.productosDetalle)}</td>
      <td>${Number(r.bultosSistema || 0)}</td><td>${Number(r.unidadesSistema || 0)}</td><td>${Number(r.asignadas || 0)}</td>
      <td>${Number(r.transitoBultos || 0)}</td><td>${excelTexto(r.estado)}</td>
      <td>${Number(r.diferenciaBultos || 0)}</td><td>${Number(r.diferenciaUnidades || 0)}</td>
      <td>${Number(r.bultosValidados || 0)}</td><td>${Number(r.unidadesValidadas || 0)}</td>
      <td>${excelTexto(r.estadoGestion)}</td><td>${excelTexto(r.observacion)}</td><td>${excelTexto(r.actualizado)}</td>
    </tr>
  `).join("");
  const htmlExcel = `<html><head><meta charset="UTF-8"></head><body><table border="1"><thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
  const blob = new Blob([htmlExcel], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inventario_activo_${pasillo ? `pasillo_${pasillo}` : "general"}.xls`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function itemsFiltrados() {
  const q = normalizar(filtroTexto);
  return ubicaciones.filter(item => item.pasillo === pasilloActivo).filter(item => {
    if (!q) return true;
    return [item.ubicacion, item.codigo, item.codAlt, item.estilo, item.descripcion].some(x => normalizar(x).includes(q));
  });
}

function actualizarFiltro(valor) {
  filtroTexto = valor;
  mantenerFocoBusqueda = true;
  clearTimeout(filtroTimer);
  filtroTimer = setTimeout(renderMobile, 180);
}

function restaurarFocoBusqueda() {
  if (!mantenerFocoBusqueda) return;
  mantenerFocoBusqueda = false;
  requestAnimationFrame(() => {
    const input = document.getElementById("buscadorValidacion");
    if (!input) return;
    input.focus();
    const fin = input.value.length;
    try { input.setSelectionRange(fin, fin); } catch {}
  });
}

function alternarVistaReporteDashboard() {
  dashboardModoReporte = !dashboardModoReporte;
  renderDashboard();
}

function pasillosDisponibles() {
  return Array.from(new Set(ubicaciones.map(u => u.pasillo))).sort((a, b) => num(a) - num(b));
}

function metricasDashboard() {
  const vals = ubicaciones.map(validacionConInventario);
  const total = vals.length || 1;
  const ok = vals.filter(v => v.estado === "OK").length;
  const falta = vals.filter(v => v.estado === "FALTA").length;
  const sobra = vals.filter(v => v.estado === "SOBRA").length;
  const pendiente = vals.filter(v => v.estado === "PENDIENTE").length;
  const incidencias = vals.filter(v => v.estado === "FALTA" || v.estado === "SOBRA");
  const regularizado = incidencias.filter(v => v.estadoGestion === "REGULARIZADO").length;
  const gestionPendiente = Math.max(0, incidencias.length - regularizado);
  const avance = (ok + falta + sobra) / total * 100;
  const regularizacion = incidencias.length ? regularizado / incidencias.length * 100 : 100;
  const pasillos = pasillosDisponibles().map(pasillo => {
    const items = vals.filter(v => v.pasillo === pasillo);
    const totalPasillo = items.length || 1;
    const validados = items.filter(v => v.estado !== "PENDIENTE").length;
    const okPasillo = items.filter(v => v.estado === "OK").length;
    const faltaPasillo = items.filter(v => v.estado === "FALTA").length;
    const sobraPasillo = items.filter(v => v.estado === "SOBRA").length;
    const pendientePasillo = items.filter(v => v.estado === "PENDIENTE").length;
    const inc = items.filter(v => v.estado === "FALTA" || v.estado === "SOBRA").length;
    return {
      pasillo,
      total: items.length,
      validados,
      ok: okPasillo,
      falta: faltaPasillo,
      sobra: sobraPasillo,
      pendiente: pendientePasillo,
      incidencias: inc,
      avance: validados / totalPasillo * 100
    };
  });
  return { vals, total: vals.length, ok, falta, sobra, pendiente, incidencias, regularizado, gestionPendiente, avance, regularizacion, pasillos };
}

function donutCss(partes) {
  let inicio = 0;
  const segmentos = partes.filter(p => p.valor > 0).map(p => {
    const fin = inicio + p.valor;
    const segmento = `${p.color} ${inicio}% ${fin}%`;
    inicio = fin;
    return segmento;
  });
  return `conic-gradient(${segmentos.join(", ") || "#e3e8f0 0 100%"})`;
}

function renderCarga(texto) {
  app.innerHTML = `<main class="content"><div class="loading">${html(texto)}</div></main>`;
}

function renderError(error) {
  app.innerHTML = `<main class="content"><div class="error-box"><strong>No se pudo cargar.</strong><p>${html(error.message || error)}</p><button class="primary" onclick="cargarDatos(true)">Reintentar</button></div></main>`;
}

function renderLogin() {
  app.className = "app-shell";
  app.innerHTML = `
    <main class="login-screen">
      <form class="login-card" onsubmit="login(event)">
        <div class="login-brand">ANC</div>
        <span>Control inventario activo</span>
        <h1>Selecciona tu vista</h1>
        <label>Usuario
          <select id="loginUser">
            <option value="celular">Validador</option>
            <option value="admin">Administrador</option>
          </select>
        </label>
        <label>Clave
          <input id="loginPass" type="password" autocomplete="current-password" enterkeyhint="go" onkeydown="if(event.key==='Enter') login(event)">
        </label>
        <button class="primary" type="submit">Ingresar</button>
        <div id="loginError" class="login-error"></div>
      </form>
    </main>
  `;
  requestAnimationFrame(() => document.getElementById("loginPass")?.focus());
}

function icono(tipo) {
  const paths = {
    dashboard: `<path d="M4 13h6V4H4v9z"></path><path d="M14 20h6V4h-6v16z"></path><path d="M4 20h6v-3H4v3z"></path>`,
    monitor: `<path d="M4 5h16v11H4z"></path><path d="M8 21h8"></path><path d="M12 16v5"></path>`,
    refresh: `<path d="M20 6v5h-5"></path><path d="M4 18v-5h5"></path><path d="M18 9a6 6 0 0 0-10-3L4 10"></path><path d="M6 15a6 6 0 0 0 10 3l4-4"></path>`,
    logout: `<path d="M10 17l5-5-5-5"></path><path d="M15 12H3"></path><path d="M21 4v16"></path>`,
    reset: `<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 15h10l1-15"></path>`,
    total: `<path d="M4 7h16"></path><path d="M4 12h16"></path><path d="M4 17h10"></path>`,
    ok: `<path d="M5 13l4 4L19 7"></path>`,
    falta: `<path d="M12 4v10"></path><path d="M12 19h.01"></path>`,
    sobra: `<path d="M12 5v14"></path><path d="M5 12h14"></path>`,
    pendiente: `<circle cx="12" cy="12" r="8"></circle><path d="M12 8v5l3 2"></path>`,
    avance: `<path d="M4 19V5"></path><path d="M4 19h16"></path><path d="M7 15l3-4 3 2 5-7"></path>`,
    pasillo: `<path d="M5 4h14v16H5z"></path><path d="M9 4v16"></path><path d="M15 4v16"></path>`,
    alerta: `<path d="M12 3l10 18H2L12 3z"></path><path d="M12 9v5"></path><path d="M12 17h.01"></path>`
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[tipo] || paths.total}</svg>`;
}

function header(titulo, subtitulo, desktop = false) {
  const r = resumen();
  const vistaActual = sesion?.vista || new URL(location.href).searchParams.get("view") || "mobile";
  return `
    <header class="top">
      <div class="top-row">
        <div class="brand"><h1>${titulo}</h1><span>${subtitulo}</span></div>
        <div class="nav-actions">
          ${desktop ? `
            <button class="icon-button ${vistaActual === "dashboard" ? "active" : ""}" onclick="abrirVista('dashboard')">${icono("dashboard")}<span>DASHBOARD</span></button>
            <button class="icon-button ${vistaActual === "monitor" ? "active" : ""}" onclick="abrirVista('monitor')">${icono("monitor")}<span>MONITOR</span></button>
            ${vistaActual === "dashboard" ? `<button class="icon-button" onclick="alternarVistaReporteDashboard()">${icono("avance")}<span>${dashboardModoReporte ? "VISTA NORMAL" : "VISTA REPORTE"}</span></button>` : ""}
          ` : ""}
          <button class="icon-button danger" onclick="reiniciarAvance()">${icono("reset")}<span>REINICIAR</span></button>
          <button class="icon-button" onclick="cerrarSesion()">${icono("logout")}<span>SALIR</span></button>
          <button class="icon-button" onclick="cargarDatos(true)">${icono("refresh")}<span>SYNC</span></button>
        </div>
      </div>
      <div class="status-strip">
        <div class="mini-kpi">${icono("total")}<span>Total</span><strong>${fmt(r.total)}</strong></div>
        <div class="mini-kpi">${icono("ok")}<span>OK</span><strong>${fmt(r.ok)}</strong></div>
        <div class="mini-kpi">${icono("pendiente")}<span>Pend.</span><strong>${fmt(r.pendiente)}</strong></div>
      </div>
    </header>
  `;
}

function renderMobile() {
  if (!ubicaciones.length) return renderCarga("Sin inventario activo operativo.");
  const pasillos = pasillosDisponibles();
  if (!pasillos.includes(pasilloActivo)) pasilloActivo = pasillos[0] || "01";
  const data = itemsFiltrados();
  const grupos = new Map();
  data.forEach(item => {
    if (!grupos.has(item.bahia)) grupos.set(item.bahia, []);
    grupos.get(item.bahia).push(item);
  });
  app.className = "app-shell";
  app.innerHTML = `
    ${header("Inventario Activo", "ANC Logistica | pasillo 10 excluido")}
    <main class="content">
      ${avisoGuardado ? `<div class="save-toast">${html(avisoGuardado)}</div>` : ""}
      <div class="toolbar">
        <input id="buscadorValidacion" value="${html(filtroTexto)}" placeholder="Buscar ubicacion, codigo o estilo" autocomplete="off" oninput="actualizarFiltro(this.value)">
        <button class="primary success" onclick="marcarTodoOkVisible()">${icono("ok")}<span>Todo visible OK</span></button>
        <button class="primary" onclick="cargarDatos(true)">${icono("refresh")}<span>Actualizar</span></button>
      </div>
      <div class="aisle-tabs">
        ${pasillos.map(p => `<button class="${p === pasilloActivo ? "active" : ""}" onclick="pasilloActivo='${p}';renderMobile()">${Number(p)}</button>`).join("")}
      </div>
      ${Array.from(grupos.entries()).map(([bahia, items]) => `
        <h2 class="bay-title">Pasillo ${Number(pasilloActivo)} | Bahia ${bahia}</h2>
        ${items.map(cardMobile).join("")}
      `).join("") || `<div class="empty">Sin ubicaciones para este filtro.</div>`}
    </main>
    ${modalCantidadHtml()}
  `;
  restaurarFocoBusqueda();
}

function cardMobile(item) {
  const val = validaciones[item.id] || {};
  const estado = estadoItem(item);
  const clase = claseEstado(estado);
  return `
    <article class="location-card ${clase}">
      <div class="location-head">
        <strong>${html(item.ubicacion)}</strong>
        <span class="pill">${html(estado)}</span>
      </div>
      <div class="product-code">${etiquetaProductoUbicacion(item)}</div>
      <p class="desc">${html(item.descripcion || "Sin descripcion")}</p>
      <div class="metric-grid">
        <div class="metric"><span>Bultos</span><strong>${fmt(item.bultos)}</strong></div>
        <div class="metric"><span>Unidades</span><strong>${fmt(item.unidades)}</strong></div>
        <div class="metric"><span>Asignadas</span><strong>${fmt(item.asignadas)}</strong></div>
        <div class="metric"><span>Transito bul</span><strong>${fmt(item.transitoBultos)}</strong></div>
      </div>
      <div class="actions-grid">
        <button class="status-btn ok" onclick="marcar('${html(item.id)}','OK')">TODO OK</button>
        <button class="status-btn falta" onclick="abrirModalCantidad('${html(item.id)}','FALTA')">FALTA</button>
        <button class="status-btn sobra" onclick="abrirModalCantidad('${html(item.id)}','SOBRA')">SOBRA</button>
      </div>
      <textarea class="obs-input" placeholder="Observacion" oninput="cambiarObs('${html(item.id)}', this.value)">${html(val.observacion || "")}</textarea>
    </article>
  `;
}

function modalCantidadHtml() {
  if (!modalCantidad) return "";
  const item = ubicaciones.find(u => u.id === modalCantidad.id);
  if (!item) return "";
  return `
    <div class="modal-backdrop" onclick="cerrarModalCantidad()">
      <form class="qty-modal" onclick="event.stopPropagation()" onsubmit="guardarModalCantidad(event)">
        <header>
          <span>${html(modalCantidad.estado === "FALTA" ? "Falta mercaderia" : "Sobra mercaderia")}</span>
          <button type="button" onclick="cerrarModalCantidad()">Cerrar</button>
        </header>
        <strong>${html(item.ubicacion)}</strong>
        <p>${etiquetaProductoUbicacion(item)}</p>
        <div class="qty-grid">
          <label>Bultos
            <input id="modalBultos" type="number" min="0" step="0.01" inputmode="decimal" value="${html(modalCantidad.bultos)}" placeholder="0">
          </label>
          <label>Unidades
            <input id="modalUnidades" type="number" min="0" step="1" inputmode="numeric" value="${html(modalCantidad.unidades)}" placeholder="0">
          </label>
        </div>
        <label>Observacion
          <textarea id="modalObs" placeholder="Detalle opcional">${html(modalCantidad.observacion)}</textarea>
        </label>
        <button class="primary" type="button" onclick="guardarModalCantidad()">Guardar incidencia</button>
      </form>
    </div>
  `;
}

function renderDashboard() {
  app.className = `app-shell desktop ${dashboardModoReporte ? "report-view" : ""}`;
  const m = metricasDashboard();
  const totalGrafico = m.total || 1;
  const incidenciaTotal = m.incidencias.length || 1;
  const pasillosOrdenados = [...m.pasillos].sort((a, b) => num(a.pasillo) - num(b.pasillo));
  const topPasillos = [...m.pasillos].sort((a, b) => b.incidencias - a.incidencias || b.avance - a.avance).slice(0, 6);
  const focoAlerta = topPasillos[0] || null;
  const focoPendiente = [...m.pasillos].sort((a, b) => b.pendiente - a.pendiente || a.avance - b.avance)[0] || null;
  const mejorPasillo = [...m.pasillos].sort((a, b) => b.avance - a.avance || b.validados - a.validados)[0] || null;
  const tendencia = pasillosOrdenados.map((p, index) => {
    const x = pasillosOrdenados.length === 1 ? 500 : 42 + (index / Math.max(pasillosOrdenados.length - 1, 1)) * 916;
    const y = 166 - (Math.min(100, p.avance) / 100) * 126;
    return { ...p, x, y };
  });
  const tendenciaPath = tendencia.reduce((path, p, index) => {
    if (!index) return `M ${p.x} ${p.y}`;
    const prev = tendencia[index - 1];
    const mid = (prev.x + p.x) / 2;
    return `${path} C ${mid} ${prev.y}, ${mid} ${p.y}, ${p.x} ${p.y}`;
  }, "");
  const donutAvance = donutCss([
    { color: "#4c7658", valor: m.ok / totalGrafico * 100 },
    { color: "#9f4742", valor: m.falta / totalGrafico * 100 },
    { color: "#d09337", valor: m.sobra / totalGrafico * 100 },
    { color: "#dfe6ef", valor: m.pendiente / totalGrafico * 100 }
  ]);
  const donutGestion = donutCss([
    { color: "#4c7658", valor: m.regularizado / incidenciaTotal * 100 },
    { color: "#d09337", valor: m.gestionPendiente / incidenciaTotal * 100 }
  ]);
  app.innerHTML = `
    ${header("Dashboard Inventario", "Vista ejecutiva de validacion y regularizacion", true)}
    <main class="content dashboard-content dashboard-redesign ${dashboardModoReporte ? "report-sheet" : ""}">
      ${avisoGuardado ? `<div class="save-toast">${html(avisoGuardado)}</div>` : ""}
      <section class="visual-hero-grid">
        <article class="visual-score-card">
          <div>
            <span>${icono("avance")}Avance general</span>
            <strong>${fmt(m.avance)}%</strong>
            <small>${fmt(m.ok + m.falta + m.sobra)} / ${fmt(m.total)} ubicaciones</small>
          </div>
          <div class="donut-xl" style="background:${donutAvance}"><b>${fmt(m.avance)}%</b></div>
        </article>
        <article class="visual-kpi-stack">
          <div class="visual-kpi ok">${icono("ok")}<span>OK</span><strong>${fmt(m.ok)}</strong></div>
          <div class="visual-kpi falta">${icono("falta")}<span>Falta</span><strong>${fmt(m.falta)}</strong></div>
          <div class="visual-kpi sobra">${icono("sobra")}<span>Sobra</span><strong>${fmt(m.sobra)}</strong></div>
          <div class="visual-kpi pendiente">${icono("pendiente")}<span>Pend.</span><strong>${fmt(m.pendiente)}</strong></div>
        </article>
        <article class="visual-donut-card">
          <header>
            <h2>${icono("ok")}Regularizacion</h2>
            <strong>${fmt(m.regularizacion)}%</strong>
          </header>
          <div class="donut-md" style="background:${donutGestion}"><b>${fmt(m.regularizado)}/${fmt(m.incidencias.length)}</b></div>
          <div class="legend-row compact">
            <span><i class="ok"></i>Regularizado</span><span><i class="sobra"></i>Pendiente</span>
          </div>
        </article>
      </section>
      <section class="visual-chart-grid">
        <article class="power-card visual-map-card">
          <div class="panel-head">
            <h2>${icono("pasillo")}Mapa de pasillos</h2>
            <button class="export-btn" onclick="abrirVista('monitor')">Ver detalle</button>
          </div>
          <div class="pasillo-tile-grid">
            ${pasillosOrdenados.map(p => `
              <article class="pasillo-tile ${p.incidencias ? "alert" : p.pendiente ? "pending" : "done"}">
                <span>P${Number(p.pasillo)}</span>
                <strong>${fmt(p.avance)}%</strong>
                <small>${fmt(p.validados)}/${fmt(p.total)}</small>
                <i style="height:${Math.max(3, Math.min(100, p.avance))}%"></i>
              </article>
            `).join("")}
          </div>
        </article>
        <article class="power-card visual-trend-card">
          <div class="panel-head"><h2>${icono("avance")}Tendencia por pasillo</h2></div>
          <svg class="trend-svg" viewBox="0 0 1000 190" preserveAspectRatio="none">
            <line x1="32" y1="166" x2="968" y2="166"></line>
            <line x1="32" y1="103" x2="968" y2="103"></line>
            <line x1="32" y1="40" x2="968" y2="40"></line>
            <path d="${tendenciaPath}"></path>
            ${tendencia.map(p => `<circle cx="${p.x}" cy="${p.y}" r="8"></circle>`).join("")}
          </svg>
          <div class="trend-axis">
            ${tendencia.map(p => `<span>P${Number(p.pasillo)}</span>`).join("")}
          </div>
        </article>
      </section>
      <section class="visual-bottom-grid">
        <article class="power-card visual-alert-card compact-alerts">
          <div class="panel-head"><h2>${icono("alerta")}Alertas</h2></div>
          <div class="alert-chip-grid">
            ${topPasillos.map(p => `
              <span class="${p.incidencias ? "hot" : ""}">P${Number(p.pasillo)} <strong>${fmt(p.incidencias)}</strong></span>
            `).join("") || `<div class="empty">Sin incidencias.</div>`}
          </div>
        </article>
        <article class="power-card visual-total-card">
          <div class="panel-head"><h2>${icono("total")}Distribucion de estado</h2></div>
          <div class="state-share">
            <div class="donut-md" style="background:${donutAvance}"><b>${fmt(m.total)}</b></div>
            <div class="state-list">
              <span><i class="ok"></i>OK <strong>${fmt(m.ok)}</strong></span>
              <span><i class="falta"></i>Falta <strong>${fmt(m.falta)}</strong></span>
              <span><i class="sobra"></i>Sobra <strong>${fmt(m.sobra)}</strong></span>
              <span><i class="pendiente"></i>Pend. <strong>${fmt(m.pendiente)}</strong></span>
            </div>
          </div>
        </article>
        <article class="power-card visual-insights-card">
          <div class="panel-head"><h2>${icono("avance")}Lectura rapida</h2></div>
          <div class="insight-grid">
            <span><b>Foco</b><strong>${focoAlerta ? `P${Number(focoAlerta.pasillo)}` : "-"}</strong><small>${fmt(focoAlerta?.incidencias || 0)} incidencias</small></span>
            <span><b>Pendiente</b><strong>${focoPendiente ? `P${Number(focoPendiente.pasillo)}` : "-"}</strong><small>${fmt(focoPendiente?.pendiente || 0)} ubic.</small></span>
            <span><b>Mejor</b><strong>${mejorPasillo ? `P${Number(mejorPasillo.pasillo)}` : "-"}</strong><small>${fmt(mejorPasillo?.avance || 0)}%</small></span>
          </div>
        </article>
      </section>
    </main>
  `;
}

function renderMonitor() {
  app.className = "app-shell desktop";
  const r = resumen();
  const porPasillo = pasillosDisponibles().map(pasillo => {
    const items = ubicaciones.filter(u => u.pasillo === pasillo);
    const vals = items.map(validacionConInventario);
    const ok = vals.filter(i => i.estado === "OK").length;
    const falta = vals.filter(i => i.estado === "FALTA").length;
    const sobra = vals.filter(i => i.estado === "SOBRA").length;
    return { pasillo, total: items.length, ok, falta, sobra, avance: items.length ? (ok + falta + sobra) / items.length * 100 : 0 };
  });
  if (monitorPasilloActivo && !porPasillo.some(p => p.pasillo === monitorPasilloActivo)) monitorPasilloActivo = "";
  const totalTransito = ubicaciones.reduce((acc, item) => acc + (Number(item.transitoBultos) || 0), 0);
  const incidencias = ubicaciones.map(validacionConInventario)
    .filter(v => v.estado === "FALTA" || v.estado === "SOBRA")
    .filter(v => !monitorPasilloActivo || v.pasillo === monitorPasilloActivo)
    .sort((a, b) => compararUbicacion(a.ubicacion, b.ubicacion));
  app.innerHTML = `
    ${header("Monitor Inventario", "Validacion en vivo por pasillo", true)}
    <main class="content">
      <section class="kpi-row">
        <article class="big-kpi"><span>Total</span><strong>${fmt(r.total)}</strong></article>
        <article class="big-kpi ok"><span>Correctos</span><strong>${fmt(r.ok)}</strong></article>
        <article class="big-kpi falta"><span>Falta merca</span><strong>${fmt(r.falta)}</strong></article>
        <article class="big-kpi sobra"><span>Sobra merca</span><strong>${fmt(r.sobra)}</strong></article>
        <article class="big-kpi"><span>Pendientes</span><strong>${fmt(r.pendiente)}</strong></article>
        <article class="big-kpi"><span>Transito bul</span><strong>${fmt(totalTransito)}</strong></article>
      </section>
      <section class="monitor-grid">
        <div class="panel progress-panel">
          <div class="panel-head">
            <h2>Avance por pasillo</h2>
            <button class="export-btn" onclick="descargarExcelInventario()">Excel general</button>
          </div>
          <div class="monitor-list">
            ${porPasillo.map(p => `
              <article class="summary-card ${p.pasillo === monitorPasilloActivo ? "selected" : ""}" onclick="monitorPasilloActivo='${p.pasillo === monitorPasilloActivo ? "" : p.pasillo}';renderMonitor()">
                <header><span>Pasillo ${Number(p.pasillo)}</span><span>${p.ok + p.falta + p.sobra}/${p.total}</span></header>
                <div class="bar"><i style="width:${Math.min(100, p.avance)}%"></i></div>
                <small>OK ${p.ok} | Falta ${p.falta} | Sobra ${p.sobra}</small>
              </article>
            `).join("")}
          </div>
        </div>
        <div class="panel issue-panel">
          <div class="panel-head">
            <h2>Incidencias${monitorPasilloActivo ? ` | Pasillo ${Number(monitorPasilloActivo)}` : ""}</h2>
            <button class="export-btn" onclick="descargarExcelInventario(monitorPasilloActivo)">Excel ${monitorPasilloActivo ? `P${Number(monitorPasilloActivo)}` : "general"}</button>
          </div>
          <table class="issue-table">
            <thead><tr><th>Ubicacion</th><th>Producto</th><th>Estado</th><th>Validacion</th><th>Gestion</th><th>Obs.</th></tr></thead>
            <tbody>
              ${incidencias.map(v => `<tr class="${claseEstado(v.estado)}"><td><strong>${html(v.ubicacion)}</strong></td><td><div class="product-cell"><strong>${etiquetaProductoUbicacion(v)}</strong><span>${html(v.descripcion || "")}</span><small>Transito: ${fmt(v.transitoBultos || 0)} bul</small></div></td><td><span class="state-chip ${claseEstado(v.estado)}">${html(v.estado)}</span></td><td>${validacionIncidenciaHtml(v)}</td><td><button class="gestion-btn ${v.estadoGestion === "REGULARIZADO" ? "regularizado" : "pendiente"}" onclick="cambiarEstadoGestion('${html(v.id)}','${html(v.estadoGestion)}')">${v.estadoGestion === "REGULARIZADO" ? "Regularizado" : "Pendiente"}</button></td><td class="obs-cell">${html(v.observacion || "-")}</td></tr>`).join("") || `<tr><td colspan="6">Sin faltantes ni sobrantes.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  `;
}

function abrirVista(vista) {
  const url = new URL(location.href);
  url.searchParams.set("view", vista);
  history.replaceState(null, "", url);
  if (sesion) {
    sesion.vista = vista;
    guardarSesion(sesion);
  }
  render();
}

function render() {
  if (!sesion) return renderLogin();
  const vista = sesion.vista || new URL(location.href).searchParams.get("view") || "mobile";
  if (vista === "dashboard") renderDashboard();
  else if (vista === "monitor") renderMonitor();
  else renderMobile();
}

canal?.addEventListener("message", event => {
  if (event.data?.tipo === "validaciones") {
    validaciones = aplicarCorteReset(event.data.validaciones || {});
    localStorage.setItem(CONFIG.VALIDACIONES_KEY, JSON.stringify(validaciones));
    render();
  }
});

setInterval(async () => {
  const vistaActual = new URL(location.href).searchParams.get("view") || "mobile";
  if (vistaActual !== "monitor" && vistaActual !== "dashboard") return;
  await cargarValidaciones();
  render();
}, CONFIG.POLL_MS);

if (sesion) {
  const url = new URL(location.href);
  url.searchParams.set("view", sesion.vista || "mobile");
  history.replaceState(null, "", url);
  cargarDatos();
} else {
  renderLogin();
}
