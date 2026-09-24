const CONFIG = {
  SPREADSHEET_ID: "1lPLRwHCIKdnQFRV1fTzgegEhPDolA4SK3LV5IAGkwiU",
  SOURCE_SPREADSHEET_ID: "1-v6vXjHpLlIn0-_lVZw0BtGopnxSHH0zqoOrW8aBwcg",
  HOJA_VALIDACIONES: "VALIDACION_INV_ACTIVO",
  HOJA_AJUSTES: "AJUSTE_INV",
  TIMEZONE: "America/Lima"
};

const HEADERS = [
  "ID", "FECHA_HORA", "UBICACION", "PASILLO", "BAHIA", "CODIGO", "COD_ALT", "ESTILO",
  "DESCRIPCION", "BULTOS", "UNIDADES", "ASIGNADAS", "TRANSITO_UND", "TRANSITO_BULTOS",
  "DIFERENCIA_BULTOS", "DIFERENCIA_UNIDADES", "TIPO_DIFERENCIA", "ESTADO", "OBSERVACION",
  "ESTADO_GESTION"
];

const AJUSTE_HEADERS = ["UBICACION", "PRODUCTO", "DESCRIPCION", "UXB", "BULTOS", "UNI_MAX", "AJUSTE"];

function doGet(e) {
  try {
    const action = normalizar_(e && e.parameter && e.parameter.action || "validaciones");
    asegurar_();
    if (action === "VALIDACIONES") return json_({ ok:true, validaciones:leerValidaciones_() });
    if (action === "AJUSTES") return json_({ ok:true, ajustes:leerAjustes_() });
    if (esReset_(action)) return json_(reiniciar_());
    return json_({ ok:false, mensaje:"Accion GET no reconocida." });
  } catch (error) {
    return json_({ ok:false, mensaje:error.message || String(error) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(5000)) throw new Error("Sistema ocupado, intenta nuevamente.");
    asegurar_();
    const body = JSON.parse(e && e.postData && e.postData.contents || "{}");
    const action = normalizar_(body.action);
    if (action === "GUARDAR") return json_(guardar_(body.registro || {}));
    if (action === "GUARDAR_AJUSTE") return json_(guardarAjuste_(body.registro || {}));
    if (esReset_(action)) return json_(reiniciar_());
    return json_({ ok:false, mensaje:"Accion POST no reconocida." });
  } catch (error) {
    return json_({ ok:false, mensaje:error.message || String(error) });
  } finally {
    try { lock.releaseLock(); } catch (error) {}
  }
}

function configurarSistema() {
  asegurar_();
  return "Sistema configurado.";
}

function asegurar_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
  let sh = ss.getSheetByName(CONFIG.HOJA_VALIDACIONES);
  if (!sh) sh = ss.insertSheet(CONFIG.HOJA_VALIDACIONES);
  const actuales = sh.getLastColumn() ? sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), HEADERS.length)).getDisplayValues()[0] : [];
  if (HEADERS.some((h, i) => actuales[i] !== h)) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.getRange(1, 1, 1, HEADERS.length).setBackground("#172033").setFontColor("#ffffff").setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  let ajustes = ss.getSheetByName(CONFIG.HOJA_AJUSTES);
  if (!ajustes) ajustes = ss.insertSheet(CONFIG.HOJA_AJUSTES);
  const encabezadosAjuste = ajustes.getLastColumn() ? ajustes.getRange(1, 1, 1, Math.max(ajustes.getLastColumn(), AJUSTE_HEADERS.length)).getDisplayValues()[0] : [];
  if (AJUSTE_HEADERS.some((h, i) => encabezadosAjuste[i] !== h)) {
    const esFormatoAnterior = encabezadosAjuste.slice(0, 5).join("|") === "UBICACION|PRODUCTO|DESCRIPCION|UNI_MAX|AJUSTE";
    const filasAnteriores = esFormatoAnterior && ajustes.getLastRow() > 1
      ? ajustes.getRange(2, 1, ajustes.getLastRow() - 1, 5).getValues()
      : [];
    ajustes.getRange(1, 1, 1, AJUSTE_HEADERS.length).setValues([AJUSTE_HEADERS]);
    if (filasAnteriores.length) {
      const migradas = filasAnteriores.map(row => [row[0], row[1], row[2], "", "", row[3], row[4] || "NO"]);
      ajustes.getRange(2, 1, ajustes.getMaxRows() - 1, AJUSTE_HEADERS.length).clearContent();
      ajustes.getRange(2, 1, migradas.length, AJUSTE_HEADERS.length).setValues(migradas);
    }
    ajustes.getRange(1, 1, 1, AJUSTE_HEADERS.length).setBackground("#172033").setFontColor("#ffffff").setFontWeight("bold");
    ajustes.setFrozenRows(1);
  }
}

function leerAjustes_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const fuenteSs = SpreadsheetApp.openById(CONFIG.SOURCE_SPREADSHEET_ID);
  const sh = ss.getSheetByName(CONFIG.HOJA_AJUSTES);
  const fuente = fuenteSs.getSheetByName("INV_ACTIVO");
  const productos = fuenteSs.getSheetByName("PRODUCTOS");
  if (!fuente) return [];
  const fuenteRows = valoresConEncabezados_(fuente);
  const productoRows = productos ? valoresConEncabezados_(productos) : [];
  const indiceProductos = new Map();
  productoRows.forEach(row => {
    const codigo = normalizar_(campo_(row, ["CODIGO", "PRODUCTO", "CODIGO PRODUCTO"]));
    if (codigo && !indiceProductos.has(codigo)) indiceProductos.set(codigo, row);
  });
  const actuales = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, AJUSTE_HEADERS.length).getValues() : [];
  const guardados = new Map(actuales.map(row => [claveAjuste_(row[0], row[1]), row]));
  const base = new Map();
  fuenteRows.forEach(row => {
    const ubicacion = limpiar_(campo_(row, ["UBICACION", "Ubicacion", "Ubicación"]));
    const producto = normalizar_(campo_(row, ["PRODUCTO", "CODIGO", "CODIGO PRODUCTO"]));
    const partes = ubicacion.toUpperCase().split("-");
    if (!ubicacion || !producto || partes[0] !== "MASS" || normalizar_(partes[1]) === "10") return;
    const info = indiceProductos.get(producto) || {};
    const descripcion = limpiar_(campo_(row, ["DESCRIPCION", "DESCRIPCIÓN"])) || limpiar_(campo_(info, ["DESCRIPCION", "DESCRIPCIÓN"]));
    const clave = claveAjuste_(ubicacion, producto);
    if (!base.has(clave)) {
      const previo = guardados.get(clave) || [];
      const uxb = Number(previo[3] || campo_(row, ["UXB", "UXB_CAJA", "UNID_CAJA", "UND_CAJA"]) || campo_(info, ["UXB", "UXB_CAJA", "UNID_CAJA", "UND_CAJA"])) || 1;
      const uniMax = previo[5] !== undefined && previo[5] !== "" ? previo[5] : campo_(row, ["UNI_MAX", "UNIDADES_MAX", "MAXIMO", "MÁXIMO", "CAPACIDAD_MAX"]);
      const bultos = uniMax === "" ? "" : Number(uniMax || 0) / uxb;
      base.set(clave, [ubicacion, producto, descripcion, uxb, bultos, uniMax === "" ? "" : Number(uniMax) || 0, previo[6] === "SI" ? "SI" : "NO"]);
    }
  });
  const filas = Array.from(base.values()).sort((a, b) => compararUbicacion_(a[0], b[0]) || String(a[1]).localeCompare(String(b[1])));
  const existentes = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, AJUSTE_HEADERS.length).getValues() : [];
  if (existentes.length) sh.getRange(2, 1, existentes.length, AJUSTE_HEADERS.length).clearContent();
  if (filas.length) sh.getRange(2, 1, filas.length, AJUSTE_HEADERS.length).setValues(filas);
  return filas.map(ajusteObjeto_);
}

function guardarAjuste_(r) {
  const ubicacion = limpiar_(r.ubicacion);
  const producto = normalizar_(r.producto);
  const uxb = Number(r.uxb) || 1;
  const uniMax = Number(r.uniMax);
  if (!ubicacion || !producto || !Number.isFinite(uniMax) || uniMax < 0) throw new Error("El ajuste debe tener una capacidad valida.");
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName(CONFIG.HOJA_AJUSTES);
  const fila = buscarFilaAjuste_(sh, ubicacion, producto);
  const bultos = Number(r.bultos) || uniMax / uxb;
  const valores = [[ubicacion, producto, limpiar_(r.descripcion), uxb, bultos, uniMax, "SI"]];
  if (fila) sh.getRange(fila, 1, 1, AJUSTE_HEADERS.length).setValues(valores);
  else sh.appendRow(valores[0]);
  return { ok: true, ajuste: ajusteObjeto_(valores[0]) };
}

function valoresConEncabezados_(sh) {
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || !lastCol) return [];
  const encabezados = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(normalizar_);
  return sh.getRange(2, 1, lastRow - 1, lastCol).getValues().map(row => Object.fromEntries(encabezados.map((h, i) => [h, row[i]])));
}

function campo_(row, nombres) {
  for (const nombre of nombres) {
    const key = normalizar_(nombre);
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return "";
}

function claveAjuste_(ubicacion, producto) {
  return normalizar_(ubicacion) + "|" + normalizar_(producto);
}

function ajusteObjeto_(row) {
  return { ubicacion: limpiar_(row[0]), producto: limpiar_(row[1]), descripcion: limpiar_(row[2]), uxb: Number(row[3] || 1), bultos: Number(row[4] || 0), uniMax: Number(row[5] || 0), ajuste: normalizar_(row[6] || "NO") === "SI" ? "SI" : "NO" };
}

function buscarFilaAjuste_(sh, ubicacion, producto) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const rows = sh.getRange(2, 1, last - 1, 2).getDisplayValues();
  const clave = claveAjuste_(ubicacion, producto);
  const index = rows.findIndex(row => claveAjuste_(row[0], row[1]) === clave);
  return index >= 0 ? index + 2 : 0;
}

function compararUbicacion_(a, b) {
  const pa = limpiar_(a).toUpperCase().split("-").slice(1).map(Number);
  const pb = limpiar_(b).toUpperCase().split("-").slice(1).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const dif = (pa[i] || 0) - (pb[i] || 0);
    if (dif) return dif;
  }
  return limpiar_(a).localeCompare(limpiar_(b));
}

function guardar_(r) {
  const id = limpiar_(r.id);
  if (!id) throw new Error("Falta ID de ubicacion/producto.");
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName(CONFIG.HOJA_VALIDACIONES);
  const fila = buscarFila_(sh, id);
  const valores = [[
    id,
    new Date(),
    limpiar_(r.ubicacion),
    limpiar_(r.pasillo),
    limpiar_(r.bahia),
    limpiar_(r.codigo),
    limpiar_(r.codAlt),
    limpiar_(r.estilo),
    limpiar_(r.descripcion),
    Number(r.bultos || 0),
    Number(r.unidades || 0),
    Number(r.asignadas || 0),
    Number(r.transitoUnd || 0),
    Number(r.transitoBultos || 0),
    Number(r.diferenciaBultos || 0),
    Number(r.diferenciaUnidades || 0),
    limpiar_(r.tipoDiferencia),
    normalizar_(r.estado || "PENDIENTE"),
    limpiar_(r.observacion),
    normalizar_(r.estadoGestion || "PENDIENTE")
  ]];
  if (fila) sh.getRange(fila, 1, 1, HEADERS.length).setValues(valores);
  else sh.appendRow(valores[0]);
  return { ok:true, registro:r };
}

function reiniciar_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName(CONFIG.HOJA_VALIDACIONES);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, Math.max(sh.getLastColumn(), HEADERS.length)).clearContent();
  return { ok:true, mensaje:"Validaciones reiniciadas." };
}

function esReset_(action) {
  return ["RESET", "REINICIAR", "LIMPIAR", "BORRAR"].indexOf(action) >= 0;
}

function leerValidaciones_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName(CONFIG.HOJA_VALIDACIONES);
  const last = sh.getLastRow();
  if (last < 2) return {};
  const rows = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const out = {};
  rows.forEach(row => {
    const id = limpiar_(row[0]);
    if (!id) return;
    out[id] = {
      id,
      actualizado: row[1] instanceof Date ? row[1].toISOString() : limpiar_(row[1]),
      ubicacion: limpiar_(row[2]),
      pasillo: limpiar_(row[3]),
      bahia: limpiar_(row[4]),
      codigo: limpiar_(row[5]),
      codAlt: limpiar_(row[6]),
      estilo: limpiar_(row[7]),
      descripcion: limpiar_(row[8]),
      bultos: Number(row[9] || 0),
      unidades: Number(row[10] || 0),
      asignadas: Number(row[11] || 0),
      transitoUnd: Number(row[12] || 0),
      transitoBultos: Number(row[13] || 0),
      diferenciaBultos: Number(row[14] || 0),
      diferenciaUnidades: Number(row[15] || 0),
      tipoDiferencia: limpiar_(row[16]),
      estado: normalizar_(row[17]),
      observacion: limpiar_(row[18]),
      estadoGestion: normalizar_(row[19] || "PENDIENTE")
    };
  });
  return out;
}

function buscarFila_(sh, id) {
  if (sh.getLastRow() < 2) return 0;
  const found = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
  return found ? found.getRow() : 0;
}

function limpiar_(v) {
  return String(v === null || v === undefined ? "" : v).trim();
}

function normalizar_(v) {
  return limpiar_(v).replace(/'/g, "").replace(/\.0$/, "").replace(/\s/g, "").toUpperCase();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
