const CONFIG = {
  SPREADSHEET_ID: "1lPLRwHCIKdnQFRV1fTzgegEhPDolA4SK3LV5IAGkwiU",
  HOJA_VALIDACIONES: "VALIDACION_INV_ACTIVO",
  TIMEZONE: "America/Lima"
};

const HEADERS = [
  "ID", "FECHA_HORA", "UBICACION", "PASILLO", "BAHIA", "CODIGO", "COD_ALT", "ESTILO",
  "DESCRIPCION", "BULTOS", "UNIDADES", "ASIGNADAS", "TRANSITO_UND", "TRANSITO_BULTOS",
  "DIFERENCIA_BULTOS", "DIFERENCIA_UNIDADES", "TIPO_DIFERENCIA", "ESTADO", "OBSERVACION",
  "ESTADO_GESTION"
];

function doGet(e) {
  try {
    const action = normalizar_(e && e.parameter && e.parameter.action || "validaciones");
    asegurar_();
    if (action === "VALIDACIONES") return json_({ ok:true, validaciones:leerValidaciones_() });
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
