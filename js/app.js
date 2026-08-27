const CONFIG = {
  SHEET_ID: "1-v6vXjHpLlIn0-_lVZw0BtGopnxSHH0zqoOrW8aBwcg",
  DEFAULT_API_URL: "https://script.google.com/macros/s/AKfycbyi0PY9LMVnQhGKuILNTBka7LSWA-N8CJF7IuDyNOBJPKVRi0L6PGtf-Z8TrfIV7rJR/exec",
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
      validaciones = aplicarCorteReset(data.validaciones);
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
    diferenciaBultos: num(extras.diferenciaBultos ?? actual.diferenciaBultos),
    diferenciaUnidades: num(extras.diferenciaUnidades ?? actual.diferenciaUnidades),
    tipoDiferencia: limpiar(extras.tipoDiferencia || actual.tipoDiferencia),
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
    "DIF_BULTOS", "DIF_UNIDADES", "BULTOS_VALIDADOS", "UNIDADES_VALIDADAS", "OBSERVACION", "ACTUALIZADO"
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
      <td>${excelTexto(r.observacion)}</td><td>${excelTexto(r.actualizado)}</td>
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
  clearTimeout(filtroTimer);
  filtroTimer = setTimeout(renderMobile, 180);
}

function pasillosDisponibles() {
  return Array.from(new Set(ubicaciones.map(u => u.pasillo))).sort((a, b) => num(a) - num(b));
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

function header(titulo, subtitulo, desktop = false) {
  const r = resumen();
  return `
    <header class="top">
      <div class="top-row">
        <div class="brand"><h1>${titulo}</h1><span>${subtitulo}</span></div>
        <div class="nav-actions">
          <button class="icon-button danger" onclick="reiniciarAvance()">REINICIAR</button>
          <button class="icon-button" onclick="cerrarSesion()">SALIR</button>
          <button class="icon-button" onclick="cargarDatos(true)">SYNC</button>
        </div>
      </div>
      <div class="status-strip">
        <div class="mini-kpi"><span>Total</span><strong>${fmt(r.total)}</strong></div>
        <div class="mini-kpi"><span>OK</span><strong>${fmt(r.ok)}</strong></div>
        <div class="mini-kpi"><span>Pend.</span><strong>${fmt(r.pendiente)}</strong></div>
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
        <input value="${html(filtroTexto)}" placeholder="Buscar ubicacion, codigo o estilo" oninput="actualizarFiltro(this.value)">
        <button class="primary" onclick="cargarDatos(true)">Actualizar</button>
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
            <thead><tr><th>Ubicacion</th><th>Producto</th><th>Estado</th><th>Validacion</th><th>Obs.</th></tr></thead>
            <tbody>
              ${incidencias.map(v => `<tr class="${claseEstado(v.estado)}"><td><strong>${html(v.ubicacion)}</strong></td><td><div class="product-cell"><strong>${etiquetaProductoUbicacion(v)}</strong><span>${html(v.descripcion || "")}</span><small>Transito: ${fmt(v.transitoBultos || 0)} bul</small></div></td><td><span class="state-chip ${claseEstado(v.estado)}">${html(v.estado)}</span></td><td>${validacionIncidenciaHtml(v)}</td><td class="obs-cell">${html(v.observacion || "-")}</td></tr>`).join("") || `<tr><td colspan="5">Sin faltantes ni sobrantes.</td></tr>`}
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
  if (vista === "monitor") renderMonitor();
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
  if ((new URL(location.href).searchParams.get("view") || "mobile") !== "monitor") return;
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
