require('dotenv').config();
const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Persistencia de logs via GitHub Gist ─────────────────────
const GIST_ID    = process.env.GIST_ID;
const GIST_TOKEN = process.env.GITHUB_TOKEN;
const GIST_FILE  = 'evaluations.json';

// Mutex para evitar escrituras simultáneas
let gistLock = Promise.resolve();

async function gistRequest(method, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'playbook-evaluator' }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, opts);
  return res.json();
}

async function readLogs() {
  try {
    const data = await gistRequest('GET');
    return JSON.parse(data.files[GIST_FILE].content);
  } catch { return []; }
}

async function saveLog(entry) {
  // Encadenar en el mutex para evitar condición de carrera
  gistLock = gistLock.then(async () => {
    try {
      const logs = await readLogs();
      logs.unshift(entry);
      await gistRequest('PATCH', { files: { [GIST_FILE]: { content: JSON.stringify(logs, null, 2) } } });
      console.log(`Log guardado: ${entry.playbook_title} — ${entry.score}%`);
    } catch (e) { console.error('Error guardando log:', e.message); }
  });
  return gistLock;
}

async function writeLogs(logs) {
  gistLock = gistLock.then(async () => {
    try {
      await gistRequest('PATCH', { files: { [GIST_FILE]: { content: JSON.stringify(logs, null, 2) } } });
    } catch (e) { console.error('Error escribiendo logs:', e.message); }
  });
  return gistLock;
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Solo se permiten archivos PDF o DOCX'));
  }
});

app.use(express.static('public'));
app.use(express.json());

// softFail: true → si está AUSENTE se trata como PARCIAL (amarillo, 0.5 pts)
// softFail: false → penalización completa (rojo, 0 pts)
const CRITERIA = [
  { id: 1,  name: 'Misión con técnica de 5 Porqués',          key: 'five_whys',         norm: 'Toyota Production System (TPS) · Lean Manufacturing',  softFail: true  },
  { id: 2,  name: 'Objetivos OKR con Key Results medibles',    key: 'okr_measurable',    norm: 'OKR Framework (John Doerr / Google) · CartoData',        softFail: false },
  { id: 3,  name: 'Conexión a OKR o Visión CartoData 2035',    key: 'vision_connection', norm: 'OKR Framework · CartoData Visión 2035',                  softFail: false },
  { id: 4,  name: 'RACI con solo un A por tarea',              key: 'raci_single_a',     norm: 'PMBOK Guide (PMI) · Matriz RACI',                        softFail: false },
  { id: 5,  name: 'Verificador QC en la RACI',                 key: 'raci_qc',           norm: 'ISO 9001:2015 §8.1 · PMBOK Guide',                       softFail: true  },
  { id: 6,  name: 'DRI por paso del proceso',                  key: 'dri_per_step',      norm: 'ISO 9001:2015 §5.3 · Apple DRI Model',                   softFail: false },
  { id: 7,  name: 'Paso QC numerado y explícito',              key: 'qc_step',           norm: 'ISO 9001:2015 §8.6 · ISO 10013:2021',                    softFail: true  },
  { id: 8,  name: 'Sección V - Umbrales cuantificados',        key: 'thresholds',        norm: 'ISO 9001:2015 §8.6 · Six Sigma (DMAIC)',                 softFail: false },
  { id: 9,  name: 'Protocolos de comunicación con tiempos',    key: 'comm_protocols',    norm: 'ITIL v4 · ISO 9001:2015 §7.4',                           softFail: false },
  { id: 10, name: 'Ruta de escalada 3 niveles',                key: 'escalation',        norm: 'ITIL v4 · ISO 9001:2015 §10.2',                          softFail: false },
  { id: 11, name: 'Recursos relacionados',                     key: 'resources',         norm: 'ISO 10013:2021 §6.5',                                    softFail: false },
  { id: 12, name: 'Fecha revisión y control versiones',        key: 'version_control',   norm: 'ISO 9001:2015 §7.5 · ISO 10013:2021 §6.2',               softFail: false }
];

const SYSTEM_PROMPT = `Eres un auditor experto en estándares de Playbooks para CartoData.
Tu tarea es evaluar documentos de Playbook contra el estándar PB-META-001.

Para cada criterio, determina si está PRESENTE (cumple), PARCIAL (cumple parcialmente) o AUSENTE (no cumple).
Sé específico en las sugerencias, indicando qué exactamente falta o cómo mejorar.

DEFINICIÓN EXACTA DE CADA CRITERIO — úsala para evaluar con precisión:

1. five_whys — Misión con técnica de 5 Porqués:
   PRESENTE: La sección de Misión incluye una cadena de al menos 3 preguntas "¿Por qué?" encadenadas que llegan a una causa raíz o valor de negocio. Puede llamarse "Porqués", "¿Por qué?", "Justificación causal" o similar.
   PARCIAL: Hay misión/propósito pero solo menciona la técnica sin aplicarla, o tiene 1-2 porqués sin llegar a causa raíz.
   AUSENTE: Solo hay descripción del proceso sin ningún razonamiento causal encadenado.

2. okr_measurable — Objetivos OKR con Key Results medibles:
   PRESENTE: Hay objetivos con al menos un Key Result que incluye número, porcentaje o fecha concreta. Puede llamarse "Key Results", "KR", "Resultados clave", "Métricas" o similar.
   PARCIAL: Hay objetivos pero los KR son cualitativos o sin fecha/métrica numérica.
   AUSENTE: Solo objetivos sin KR, o sin sección de objetivos.

3. vision_connection — Conexión a OKR o Visión CartoData 2035:
   PASO 1 — Clasifica el Playbook usando esta pregunta clave:
   ¿El documento principal objeto es un OBJETO FÍSICO o EQUIPO TANGIBLE (algo que se puede tocar, usar, guardar, consumir, mantener o inventariar)?

   Si SÍ → TIPO A. Marca inmediatamente como NO_APLICA. No evalúes más este criterio.

   Ejemplos TIPO A (marcar NO_APLICA sin dudar):
   - Lentes, anteojos, gafas, visores 3D o estereoscópicos
   - Drones, aeronaves, cámaras, sensores, GPS, equipos de medición
   - Vehículos, herramientas, maquinaria, consumibles
   - Inventarios de equipos, control de activos físicos
   - Kits, maletines, insumos, materiales de campo

   Si NO → continuar al PASO 2:
   ¿El documento gestiona un PROCESO DE TRABAJO de un área o equipo?
   Si SÍ → TIPO B (evaluar normalmente, weight: 1)
   ¿El documento define LINEAMIENTOS, POLÍTICAS o METODOLOGÍA organizacional?
   Si SÍ → TIPO C (evaluar con peso doble, weight: 2)

   REGLA CRÍTICA: Si el título o contenido menciona equipo físico, lentes, drones, sensores, activos, inventario o equipo tangible → TIPO A → NO_APLICA. La ausencia de OKR en estos documentos es CORRECTA y esperada, no es un fallo.

   Si TIPO A → status: "NO_APLICA", evidence: "Playbook de gestión de activo físico/equipo — la conexión a OKR estratégicos no aplica a documentos operativos de equipos tangibles", suggestion: "", playbook_type: "A", weight: 0
   Si TIPO B → evaluar: PRESENTE/PARCIAL/AUSENTE, playbook_type: "B", weight: 1
   Si TIPO C → evaluar con peso doble: PRESENTE/PARCIAL/AUSENTE, playbook_type: "C", weight: 2

   Para TIPO B y C:
   PRESENTE: El documento menciona explícitamente su alineación con algún OKR del área/empresa o con la Visión CartoData 2035.
   PARCIAL: Hay mención vaga de "alineación estratégica" sin OKR o visión específica.
   AUSENTE: No hay ninguna referencia a objetivos organizacionales superiores.

   En el JSON de vision_connection incluir: "playbook_type": "A|B|C", "weight": 0|1|2

4. raci_single_a — RACI con solo un A por tarea:
   PRESENTE: Existe una matriz RACI (o tabla de responsabilidades) donde cada tarea/fila tiene exactamente un "A" (Accountable/Responsable final). La tabla puede llamarse RACI, matriz de roles, tabla de responsabilidades, etc.
   PARCIAL: Hay RACI pero alguna tarea tiene doble A o ningún A, o la matriz está incompleta.
   AUSENTE: No hay ninguna matriz de roles o responsabilidades.

5. raci_qc — Verificador QC en la RACI:
   PRESENTE: La matriz RACI incluye una fila o columna dedicada a Control de Calidad, revisión, verificación o QC con asignación R o A. También aplica si hay un paso de revisión con responsable en la RACI.
   PARCIAL: Se menciona QC o revisión en el texto pero no está integrado como tarea en la RACI.
   AUSENTE: No hay ninguna tarea o rol de QC/verificación en la RACI.

6. dri_per_step — DRI por paso del proceso:
   PRESENTE: Cada paso numerado del proceso/SOP indica quién es el responsable (puede llamarse DRI, Dueño, Responsable, Owner, Ejecutor, Líder). No necesita la palabra "DRI" exacta.
   PARCIAL: Algunos pasos tienen responsable pero no todos, o solo hay un responsable general del proceso.
   AUSENTE: Los pasos no tienen responsables asignados.

7. qc_step — Paso QC numerado y explícito:
   PRESENTE: Existe un paso numerado dedicado a verificación, revisión, control de calidad o aprobación dentro del flujo del proceso. Puede llamarse "Revisión y Aprobación", "Control de Calidad", "Verificación", "QC", "Paso de revisión", etc.
   PARCIAL: Se menciona revisión pero no como paso numerado independiente, o está en un anexo.
   AUSENTE: No hay ningún paso de verificación en el flujo del proceso.

8. thresholds — Sección V - Umbrales cuantificados:
   PRESENTE: Existe una sección con criterios numéricos de aceptación/rechazo. Puede incluir porcentajes, tiempos, cantidades, semáforos (verde/amarillo/rojo) con valores numéricos o rangos. Puede llamarse "Umbrales", "Umbrales y Líneas Rojas", "Líneas Rojas", "Criterios de aceptación", "Estándares de calidad", "SLA", "Métricas", "KPIs", "Matriz de prioridad", "Indicadores", "Niveles de servicio", etc. Una tabla con columnas Verde/Amarillo/Rojo y valores numéricos cuenta como PRESENTE.
   PARCIAL: Hay criterios de calidad mencionados pero sin números específicos, o solo cualitativos.
   AUSENTE: No hay criterios de aceptación medibles.

9. comm_protocols — Protocolos de comunicación con tiempos:
   PRESENTE: El documento define canales de comunicación (Slack, email, reuniones, etc.) con tiempos de respuesta esperados (horas, días). Puede estar en cualquier sección.
   PARCIAL: Menciona canales pero sin tiempos de respuesta, o tiempos pero sin canales específicos.
   AUSENTE: No hay protocolos de comunicación definidos.

10. escalation — Ruta de escalada 3 niveles:
    PRESENTE: El documento tiene una ruta de escalada con al menos 3 niveles o pasos diferenciados para resolver problemas. Los niveles pueden llamarse "Nivel 1/2/3", "Paso 1/2/3", "Fase 1/2/3", o cualquier nomenclatura que describa quién resuelve primero, quién interviene después y quién es la última instancia. No se requiere la palabra "nivel" — "paso" también cuenta.
    PARCIAL: Hay escalada mencionada pero con menos de 3 niveles/pasos, o sin descripción de cuándo activar cada uno.
    AUSENTE: No hay ninguna ruta de escalada documentada.

11. resources — Recursos relacionados:
    CONTEXTO IMPORTANTE SOBRE LINKS EN DOCUMENTOS:
    - Si el documento fue evaluado desde Google Docs (verás "[LINK: url]" en el texto), los hipervínculos son visibles y debes evaluarlos directamente.
    - Si el documento fue subido como PDF o DOCX, los hipervínculos NO se preservan en la extracción de texto. En este caso, un nombre de documento específico y único PUEDE tener un link real en el original que no es visible aquí. Sé más tolerante en este caso.

    REGLAS DE CLASIFICACIÓN:
    - [LINK]: el texto contiene una URL visible (https://, http://, drive.google.com, [LINK: ...], etc.)
    - [RUTA]: el texto describe una ruta de carpeta/directorio (ej: "Google Drive > Folder > Archivo", "SharePoint > Procesos > ...")
    - [NOMBRE ESPECÍFICO]: nombre propio de un documento concreto sin ruta ni link (ej: "PB-XYZ-000 Formato Playbook", "Inventario de Activos Lentes 3D"). En PDF/DOCX, ASUMIR que puede existir un link no visible.
    - [GENÉRICO]: referencia vaga sin nombre específico (ej: "ver el manual", "consultar documentación")

    CALIFICACIÓN:
    PRESENTE: Al menos 2 recursos que sean [LINK], [RUTA] o [NOMBRE ESPECÍFICO]. Los [NOMBRE ESPECÍFICO] en documentos PDF/DOCX cuentan como válidos.
    PARCIAL: Solo 1 recurso válido, o mezcla donde algunos son [GENÉRICO], o en Google Docs hay recursos con [SOLO NOMBRE] sin link cuando los demás sí tienen link.
    AUSENTE: Solo referencias [GENÉRICO] o sin sección de recursos.

    En la evidence, clasificar cada recurso con su etiqueta. En la suggestion, solo indicar mejora de agregar link/ruta si el documento vino de Google Docs y se confirmó que no tiene link, NO para PDFs/DOCX donde el link puede existir pero no ser visible.

12. version_control — Fecha revisión y control versiones:
    PRESENTE: El documento incluye número de versión (v1.0, versión 2, etc.) Y al menos una fecha (creación, revisión o próxima revisión). Puede estar en el encabezado, pie de página o tabla de control.
    PARCIAL: Solo hay versión sin fechas, o solo fecha sin versión.
    AUSENTE: No hay ningún control de versiones ni fechas.

Responde ÚNICAMENTE con un JSON válido con esta estructura exacta:
{
  "criteria": {
    "five_whys": { "status": "PRESENTE|PARCIAL|AUSENTE", "evidence": "texto de evidencia encontrada", "suggestion": "sugerencia específica si aplica" },
    "okr_measurable": { "status": "PRESENTE|PARCIAL|AUSENTE", "evidence": "...", "suggestion": "..." },
    "vision_connection": { "status": "PRESENTE|PARCIAL|AUSENTE|NO_APLICA", "evidence": "...", "suggestion": "...", "playbook_type": "A|B|C", "weight": 0 },
    "raci_single_a": { "status": "PRESENTE|PARCIAL|AUSENTE", "evidence": "...", "suggestion": "..." },
    "raci_qc": { "status": "PRESENTE|PARCIAL|AUSENTE", "evidence": "...", "suggestion": "..." },
    "dri_per_step": { "status": "PRESENTE|PARCIAL|AUSENTE", "evidence": "...", "suggestion": "..." },
    "qc_step": { "status": "PRESENTE|PARCIAL|AUSENTE", "evidence": "...", "suggestion": "..." },
    "thresholds": { "status": "PRESENTE|PARCIAL|AUSENTE", "evidence": "...", "suggestion": "..." },
    "comm_protocols": { "status": "PRESENTE|PARCIAL|AUSENTE", "evidence": "...", "suggestion": "..." },
    "escalation": { "status": "PRESENTE|PARCIAL|AUSENTE", "evidence": "...", "suggestion": "..." },
    "resources": { "status": "PRESENTE|PARCIAL|AUSENTE", "evidence": "...", "suggestion": "..." },
    "version_control": { "status": "PRESENTE|PARCIAL|AUSENTE", "evidence": "...", "suggestion": "..." }
  },
  "summary": "Resumen ejecutivo del playbook evaluado en 2-3 oraciones",
  "playbook_title": "Título o nombre del playbook identificado"
}`;

async function extractText(buffer, mimetype, originalname) {
  const ext = path.extname(originalname).toLowerCase();
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } else if (ext === '.pdf') {
    const data = await pdfParse(buffer);
    return data.text;
  }
  throw new Error('Formato no soportado');
}

// ── Extrae texto desde Google Docs ───────────────────────────
function extractGoogleDocId(url) {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

async function extractTextFromGoogleDoc(url) {
  const docId = extractGoogleDocId(url);
  if (!docId) throw new Error('URL de Google Docs no válida. Asegúrate de que sea un enlace como: https://docs.google.com/document/d/ID/edit');

  // Exportar como HTML para preservar hipervínculos
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=html`;
  const res = await fetch(exportUrl, { redirect: 'follow' });

  if (res.status === 403) throw new Error('El documento no es público. Cambia el acceso a "Cualquier persona con el enlace puede ver" en Google Docs.');
  if (res.status === 404) throw new Error('Documento no encontrado. Verifica que el enlace sea correcto.');
  if (!res.ok) throw new Error(`Error al acceder al documento: ${res.status}`);

  const html = await res.text();
  // Convertir HTML a texto enriquecido preservando links visibles para Claude
  const text = htmlToEnrichedText(html);
  if (!text || text.trim().length < 100) throw new Error('El documento está vacío o no se pudo extraer texto.');
  return text;
}

// Convierte HTML a texto enriquecido preservando estructura, links e imágenes
function htmlToEnrichedText(html) {
  let text = html;

  // 1. Eliminar <head>, <style>, <script> completos
  text = text
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');

  // 2. Imágenes → [IMAGEN: alt] para que Claude sepa que hay contenido visual
  text = text.replace(/<img[^>]*alt=["']([^"']+)["'][^>]*\/?>/gi, '[IMAGEN: $1]');
  text = text.replace(/<img[^>]*\/?>/gi, '[IMAGEN]');

  // 3. Encabezados → marcadores de sección legibles
  text = text
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `\n\n## ${c.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `\n\n### ${c.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `\n\n#### ${c.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, c) => `\n${c.replace(/<[^>]+>/g, '').trim()}\n`);

  // 4. Links → "texto [LINK: url]" decodificando redirects de Google
  text = text.replace(/<a\s+[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
    const linkText = content.replace(/<[^>]+>/g, '').trim();
    if (!linkText) return '';
    // Decodificar URL de redirección de Google (google.com/url?q=...)
    if (href.includes('google.com/url') || href.includes('google.com/url?q=')) {
      const match = href.match(/[?&]q=([^&]+)/);
      const realUrl = match ? decodeURIComponent(match[1]) : href;
      return `${linkText} [LINK: ${realUrl}]`;
    }
    return href.startsWith('http') ? `${linkText} [LINK: ${href}]` : linkText;
  });
  // Links ancla restantes — solo el texto
  text = text.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, (_, c) => c.replace(/<[^>]+>/g, '').trim());

  // 5. Tablas → formato legible con | separadores
  text = text
    .replace(/<table[^>]*>/gi, '\n[TABLA]\n')
    .replace(/<\/table>/gi, '[/TABLA]\n')
    .replace(/<thead[^>]*>|<\/thead>/gi, '')
    .replace(/<tbody[^>]*>|<\/tbody>/gi, '')
    .replace(/<tr[^>]*>/gi, '')
    .replace(/<\/tr>/gi, ' |\n')
    .replace(/<th[^>]*>/gi, '| ')
    .replace(/<\/th>/gi, ' ')
    .replace(/<td[^>]*>/gi, '| ')
    .replace(/<\/td>/gi, ' ');

  // 6. Listas → con marcadores
  text = text
    .replace(/<ul[^>]*>/gi, '\n')
    .replace(/<\/ul>/gi, '\n')
    .replace(/<ol[^>]*>/gi, '\n')
    .replace(/<\/ol>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n');

  // 7. Saltos de línea y párrafos
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<hr[^>]*\/?>/gi, '\n---\n');

  // 8. Texto en negrita/cursiva → preservar contenido
  text = text
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '$1')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '$1')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '$1')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '$1');

  // 9. Eliminar todos los tags restantes
  text = text.replace(/<[^>]+>/g, '');

  // 10. Decodificar entidades HTML
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#\d+;/g, ' ');

  // 11. Limpiar espacios y líneas excesivas
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

function calculateScore(criteriaResult) {
  let score = 0;
  let denominator = 0;

  for (const c of CRITERIA) {
    const cr     = criteriaResult[c.key] || {};
    const status = cr.status || 'AUSENTE';

    // NO_APLICA → excluir del score completamente
    if (status === 'NO_APLICA') continue;

    // Peso: doble para estratégico (weight=2), normal para el resto
    const weight = (c.key === 'vision_connection' && cr.weight === 2) ? 2 : 1;
    denominator += weight;

    if      (status === 'PRESENTE')                    score += 1 * weight;
    else if (status === 'PARCIAL')                     score += 0.5 * weight;
    else if (status === 'AUSENTE' && c.softFail)       score += 0.5 * weight;
  }

  if (denominator === 0) return 0;
  return Math.round((score / denominator) * 100);
}

// Aplica softFail: si el criterio es softFail y está AUSENTE, lo muestra como PARCIAL
function applysoftFail(criteriaResult) {
  const adjusted = {};
  for (const c of CRITERIA) {
    const original = criteriaResult[c.key] || { status: 'AUSENTE', evidence: '', suggestion: '' };
    // NO_APLICA nunca se toca
    if (original.status === 'NO_APLICA') {
      adjusted[c.key] = original;
    } else if (c.softFail && original.status === 'AUSENTE') {
      adjusted[c.key] = {
        ...original,
        status: 'PARCIAL',
        suggestion: (original.suggestion || '') + ' (Criterio flexible — mejora recomendada pero no bloqueante.)'
      };
    } else {
      adjusted[c.key] = original;
    }
  }
  return adjusted;
}

function getVerdict(score) {
  if (score >= 80) return 'APROBADO';
  if (score >= 60) return 'REVISAR';
  return 'RECHAZADO';
}

app.post('/api/evaluate', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

    const text = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);

    if (!text || text.trim().length < 100) {
      return res.status(400).json({ error: 'El documento está vacío o no se pudo extraer texto' });
    }

    const truncatedText = text.slice(0, 40000);

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `FUENTE: Archivo subido (PDF/DOCX) — los hipervínculos NO se preservan en la extracción de texto. Para el criterio 11, tratar nombres específicos de documentos como válidos aunque no tengan URL visible.\n\nEvalúa el siguiente Playbook contra el estándar PB-META-001:\n\n${truncatedText}`
        }
      ]
    });

    const rawContent = message.content[0].text;
    console.log('--- Respuesta Claude ---\n', rawContent.slice(0, 500), '\n---');

    let parsed;
    try {
      // Intento 1: parsear directo
      parsed = JSON.parse(rawContent);
    } catch {
      try {
        // Intento 2: extraer el bloque JSON más externo con balance de llaves
        let start = rawContent.indexOf('{');
        if (start === -1) throw new Error('No se encontró JSON en la respuesta');
        let depth = 0, end = -1;
        for (let i = start; i < rawContent.length; i++) {
          if (rawContent[i] === '{') depth++;
          else if (rawContent[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end === -1) throw new Error('JSON incompleto en la respuesta');
        parsed = JSON.parse(rawContent.slice(start, end + 1));
      } catch (parseErr) {
        console.error('Parse error:', parseErr.message);
        console.error('Raw completo:', rawContent);
        return res.status(500).json({ error: 'Error al parsear respuesta de IA: ' + parseErr.message, raw: rawContent.slice(0, 1000) });
      }
    }

    const adjustedCriteria = applysoftFail(parsed.criteria);
    const score = calculateScore(adjustedCriteria);
    const verdict = getVerdict(score);

    const response = {
      filename: req.file.originalname,
      playbook_title: parsed.playbook_title || req.file.originalname,
      score,
      verdict,
      summary: parsed.summary,
      criteria: CRITERIA.map(c => ({
        ...c,
        ...adjustedCriteria[c.key],
        status: adjustedCriteria[c.key]?.status || 'AUSENTE'
      })),
      evaluated_at: new Date().toISOString()
    };

    // Guardar en log
    saveLog({
      id: Date.now(),
      filename: response.filename,
      playbook_title: response.playbook_title,
      score: response.score,
      verdict: response.verdict,
      evaluated_at: response.evaluated_at,
      criteria_summary: {
        presente: response.criteria.filter(c => c.status === 'PRESENTE').length,
        parcial:  response.criteria.filter(c => c.status === 'PARCIAL').length,
        ausente:  response.criteria.filter(c => c.status === 'AUSENTE').length,
      }
    });

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Evaluar desde Google Docs URL ────────────────────────────
app.post('/api/evaluate-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No se recibió URL' });

    const text = await extractTextFromGoogleDoc(url);
    const docId = extractGoogleDocId(url);
    const filename = `google-doc-${docId}.txt`;

    const truncatedText = text.slice(0, 40000);

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `FUENTE: Google Docs (HTML exportado) — los hipervínculos SÍ están preservados como [LINK: url] en el texto. Para el criterio 11, evaluar los links visibles directamente y señalar cuáles recursos NO tienen link.\n\nEvalúa el siguiente Playbook contra el estándar PB-META-001:\n\n${truncatedText}` }]
    });

    const rawContent = message.content[0].text;
    let parsed;
    try { parsed = JSON.parse(rawContent); } catch {
      try {
        let start = rawContent.indexOf('{'), depth = 0, end = -1;
        for (let i = start; i < rawContent.length; i++) {
          if (rawContent[i] === '{') depth++;
          else if (rawContent[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        parsed = JSON.parse(rawContent.slice(start, end + 1));
      } catch (e) {
        return res.status(500).json({ error: 'Error al parsear respuesta de IA: ' + e.message });
      }
    }

    const adjustedCriteria = applysoftFail(parsed.criteria);
    const score   = calculateScore(adjustedCriteria);
    const verdict = getVerdict(score);

    const response = {
      filename,
      playbook_title: parsed.playbook_title || 'Google Doc',
      source_url: url,
      score, verdict,
      summary: parsed.summary,
      criteria: CRITERIA.map(c => ({
        ...c, ...adjustedCriteria[c.key],
        status: adjustedCriteria[c.key]?.status || 'AUSENTE'
      })),
      evaluated_at: new Date().toISOString()
    };

    saveLog({
      id: Date.now(),
      filename: response.filename,
      playbook_title: response.playbook_title,
      source_url: url,
      score, verdict,
      evaluated_at: response.evaluated_at,
      criteria_summary: {
        presente: response.criteria.filter(c => c.status === 'PRESENTE').length,
        parcial:  response.criteria.filter(c => c.status === 'PARCIAL').length,
        ausente:  response.criteria.filter(c => c.status === 'AUSENTE').length,
      }
    });

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API de logs ───────────────────────────────────────────────
app.get('/api/logs', async (req, res) => res.json(await readLogs()));

app.delete('/api/logs/:id', async (req, res) => {
  const logs = (await readLogs()).filter(l => String(l.id) !== req.params.id);
  await writeLogs(logs);
  res.json({ ok: true });
});

app.post('/api/export-pdf', async (req, res) => {
  try {
    const { html, filename } = req.body;
    if (!html) return res.status(400).json({ error: 'No HTML provided' });

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' } });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'reporte-playbook.pdf'}"`);
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Evaluador de Playbooks CartoData corriendo en http://localhost:${PORT}`);
});
