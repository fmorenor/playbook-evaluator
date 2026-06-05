/* ── State ── */
let selectedFile = null;
let lastResult = null;

/* ── DOM ── */
const fileInput      = document.getElementById('file-input');
const dropZone       = document.getElementById('drop-zone');
const fileNameEl     = document.getElementById('file-name');
const evaluateBtn    = document.getElementById('evaluate-btn');
const uploadSection  = document.getElementById('upload-section');
const loadingSection = document.getElementById('loading-section');
const resultsSection = document.getElementById('results-section');
const exportBtn      = document.getElementById('export-btn');
const newEvalBtn     = document.getElementById('new-eval-btn');
const stepAnalyze    = document.getElementById('step-analyze');
const stepReport     = document.getElementById('step-report');

/* ── File selection ── */
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileInput.value = ''; // reset para permitir seleccionar el mismo archivo de nuevo
  if (file) setFile(file);
});

dropZone.addEventListener('click', (e) => {
  // Si el clic viene del label, ya abre el picker nativamente — no duplicar
  if (e.target.closest('label')) return;
  fileInput.click();
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});

function setFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'docx'].includes(ext)) {
    showError('Solo se permiten archivos PDF o DOCX');
    return;
  }
  selectedFile = file;
  fileNameEl.textContent = `📄 ${file.name} (${formatBytes(file.size)})`;
  evaluateBtn.disabled = false;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ── Evaluate ── */
evaluateBtn.addEventListener('click', runEvaluation);

async function runEvaluation() {
  if (!selectedFile) return;

  uploadSection.classList.add('hidden');
  loadingSection.classList.remove('hidden');
  resultsSection.classList.add('hidden');

  // Animate loading steps
  const t1 = setTimeout(() => stepAnalyze.classList.add('active'), 1500);
  const t2 = setTimeout(() => {
    stepAnalyze.classList.remove('active');
    stepAnalyze.classList.add('done');
    stepReport.classList.add('active');
  }, 4000);

  const formData = new FormData();
  formData.append('file', selectedFile);

  try {
    const res = await fetch('/api/evaluate', { method: 'POST', body: formData });
    clearTimeout(t1); clearTimeout(t2);

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Error en el servidor');
    }

    const data = await res.json();
    lastResult = data;
    renderResults(data);
  } catch (err) {
    clearTimeout(t1); clearTimeout(t2);
    loadingSection.classList.add('hidden');
    uploadSection.classList.remove('hidden');
    showError(err.message);
  }
}

/* ── Render Results ── */
function renderResults(data) {
  loadingSection.classList.add('hidden');
  resultsSection.classList.remove('hidden');

  // Score circle
  const scoreNum = document.getElementById('score-number');
  const scoreRing = document.getElementById('score-ring');
  const circumference = 326.7;

  // Animate counter
  let current = 0;
  const target = data.score;
  const step = Math.ceil(target / 40);
  const timer = setInterval(() => {
    current = Math.min(current + step, target);
    scoreNum.textContent = current;
    const offset = circumference - (circumference * current / 100);
    scoreRing.style.strokeDashoffset = offset;
    if (current >= target) clearInterval(timer);
  }, 25);

  // Color ring by verdict
  const colors = { APROBADO: '#22C55E', REVISAR: '#F59E0B', RECHAZADO: '#EF4444' };
  scoreRing.style.stroke = colors[data.verdict] || '#4A7EC0';

  // Verdict badge
  const verdictEl = document.getElementById('verdict-badge');
  verdictEl.textContent = data.verdict;
  verdictEl.className = `verdict-badge verdict-${data.verdict}`;

  // Texts
  document.getElementById('playbook-title').textContent = data.playbook_title || data.filename;
  document.getElementById('summary-text').textContent   = data.summary || '';

  const passed  = data.criteria.filter(c => c.status === 'PRESENTE').length;
  const partial = data.criteria.filter(c => c.status === 'PARCIAL').length;
  const na      = data.criteria.filter(c => c.status === 'NO_APLICA').length;
  const active  = 12 - na;
  document.getElementById('criteria-passed').textContent =
    `${passed} completos, ${partial} parciales${na > 0 ? `, ${na} no aplican` : ''} / ${active} activos`;

  const evalDate = new Date(data.evaluated_at);
  document.getElementById('evaluated-at').textContent = evalDate.toLocaleString('es-MX', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  // Criteria grid
  const grid = document.getElementById('criteria-grid');
  grid.innerHTML = '';
  data.criteria.forEach(c => {
    const div = document.createElement('div');
    div.className = `criterion-item criterion-${c.status}`;
    div.innerHTML = `
      <div class="criterion-header">
        <div class="criterion-light light-${c.status}"></div>
        <div class="criterion-info">
          <div class="criterion-num">CRITERIO ${c.id}</div>
          <div class="criterion-name">${c.name}</div>
          <div class="criterion-status-text status-${c.status}">${c.status}</div>
          ${c.norm ? `<div class="criterion-norm">📐 ${c.norm}</div>` : ''}
          ${c.weight === 2 ? `<div class="criterion-norm" style="background:rgba(99,51,168,.12);color:#6333a8;">⚖️ Peso doble — criterio estratégico</div>` : ''}
          ${c.status === 'NO_APLICA' ? `<div class="criterion-norm" style="background:#EDF2F7;color:#718096;">⊘ No aplica para este tipo de Playbook</div>` : ''}
          ${c.evidence && c.status !== 'NO_APLICA' ? `<div class="criterion-evidence">${c.evidence}</div>` : ''}
          ${c.suggestion && c.status !== 'PRESENTE' && c.status !== 'NO_APLICA' ? `<div class="criterion-suggestion">💡 ${c.suggestion}</div>` : ''}
        </div>
      </div>`;
    grid.appendChild(div);
  });

  // Suggestions
  const sugList = document.getElementById('suggestions-list');
  sugList.innerHTML = '';
  const withSuggestions = data.criteria.filter(c => c.suggestion && c.status !== 'PRESENTE');

  if (withSuggestions.length === 0) {
    sugList.innerHTML = '<div class="no-suggestions">✅ No hay sugerencias adicionales — el playbook cumple todos los criterios.</div>';
  } else {
    withSuggestions.forEach((c, i) => {
      const div = document.createElement('div');
      div.className = `suggestion-item sug-${c.status}`;
      div.innerHTML = `
        <div class="sug-number">${i + 1}</div>
        <div class="sug-content">
          <div class="sug-criterion">Criterio ${c.id} · ${c.name}</div>
          <div class="sug-text">${c.suggestion}</div>
        </div>`;
      sugList.appendChild(div);
    });
  }

  // Hide suggestions card if not needed
  document.getElementById('suggestions-card').classList.toggle('hidden', withSuggestions.length === 0);

  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

/* ── New Evaluation ── */
newEvalBtn.addEventListener('click', () => {
  selectedFile = null;
  lastResult = null;
  fileInput.value = '';
  fileNameEl.textContent = '';
  evaluateBtn.disabled = true;

  // Reset loading steps
  stepAnalyze.classList.remove('active', 'done');
  stepReport.classList.remove('active', 'done');
  document.querySelectorAll('.step')[0].classList.add('active');

  resultsSection.classList.add('hidden');
  uploadSection.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ── Export PDF — generado en el navegador (sin Puppeteer) ── */
exportBtn.addEventListener('click', () => {
  if (!lastResult) return;

  const html = buildReportHTML(lastResult);
  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();

  // Esperar a que cargue y lanzar print
  win.onload = () => {
    setTimeout(() => {
      win.print();
      // Cerrar ventana después de imprimir/cancelar
      win.onafterprint = () => win.close();
    }, 400);
  };
});

/* ── Build Report HTML for PDF ── */
function buildReportHTML(data) {
  const colors = { APROBADO: '#22C55E', REVISAR: '#F59E0B', RECHAZADO: '#EF4444' };
  const bgColors = { PRESENTE: '#F0FDF4', PARCIAL: '#FFFBEB', AUSENTE: '#FEF2F2' };
  const dotColors = { PRESENTE: '#22C55E', PARCIAL: '#F59E0B', AUSENTE: '#EF4444' };
  const textColors = { PRESENTE: '#16a34a', PARCIAL: '#b45309', AUSENTE: '#dc2626' };

  const criteriaRows = data.criteria.map(c => `
    <div style="display:flex;gap:12px;padding:12px 14px;border-radius:8px;background:${bgColors[c.status]};margin-bottom:8px;border:1.5px solid ${dotColors[c.status]}33;">
      <div style="width:12px;height:12px;border-radius:50%;background:${dotColors[c.status]};flex-shrink:0;margin-top:4px;"></div>
      <div>
        <div style="font-size:11px;color:#8A9BBD;font-weight:700;text-transform:uppercase;letter-spacing:.3px;">Criterio ${c.id}</div>
        <div style="font-size:13px;font-weight:600;color:#131E3B;margin:2px 0;">${c.name}</div>
        <div style="font-size:11px;font-weight:700;color:${textColors[c.status]};">${c.status}</div>
        ${c.norm ? `<div style="font-size:10px;font-weight:600;color:#3366AA;background:rgba(74,126,192,.1);border-radius:4px;padding:3px 7px;margin-top:5px;display:inline-block;">📐 ${c.norm}</div>` : ''}
        ${c.evidence ? `<div style="font-size:12px;color:#4A5568;margin-top:6px;font-style:italic;line-height:1.6;background:rgba(0,0,0,.03);border-radius:4px;padding:6px 8px;word-break:break-word;white-space:pre-wrap;">${c.evidence}</div>` : ''}
        ${c.suggestion && c.status !== 'PRESENTE' ? `<div style="font-size:12px;color:#131E3B;margin-top:6px;padding:6px 10px;background:rgba(74,126,192,.08);border-left:3px solid #4A7EC0;border-radius:0 4px 4px 0;line-height:1.6;word-break:break-word;white-space:pre-wrap;">💡 ${c.suggestion}</div>` : ''}
      </div>
    </div>`).join('');

  const evalDate = new Date(data.evaluated_at).toLocaleString('es-MX');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color:#131E3B; margin:0; padding:0; }
    .header { background:#131E3B; color:white; padding:24px 32px; display:flex; align-items:center; gap:14px; }
    .header h1 { font-size:20px; margin:0; }
    .header .sub { font-size:13px; color:rgba(255,255,255,.6); margin-top:2px; }
    .badge { background:#4A7EC0; color:white; font-size:11px; font-weight:700; padding:3px 10px; border-radius:20px; }
    .content { padding:28px 32px; }
    .score-row { display:flex; align-items:center; gap:24px; margin-bottom:28px; padding:24px; background:#F8FAFC; border-radius:12px; border:1px solid #DDE4EF; }
    .score-big { font-size:56px; font-weight:900; line-height:1; }
    .verdict { font-size:14px; font-weight:800; letter-spacing:1px; padding:5px 16px; border-radius:20px; display:inline-block; margin-bottom:8px; }
    .title { font-size:18px; font-weight:700; margin-bottom:6px; }
    .summary { font-size:13px; color:#4A5568; line-height:1.6; }
    .section-title { font-size:15px; font-weight:700; border-bottom:2px solid #EEF2F7; padding-bottom:8px; margin:24px 0 14px; }
    .footer { text-align:center; font-size:11px; color:#8A9BBD; padding:16px; border-top:1px solid #EEF2F7; margin-top:24px; }
    .grid { display:grid; grid-template-columns:1fr; gap:8px; }
    * { word-break:break-word; }
    @media print {
      body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
      .card { page-break-inside: avoid; }
    }
    @page { margin: 15mm; size: A4; }
  </style></head><body>
  <div class="header">
    <div>
      <div style="display:flex;align-items:center;gap:10px;">
        <h1>Reporte de Evaluación</h1>
        <span class="badge">PB-META-001</span>
      </div>
      <div class="sub">CartoData · Generado el ${evalDate}</div>
    </div>
  </div>
  <div class="content">
    <div class="score-row">
      <div class="score-big" style="color:${colors[data.verdict]}">${data.score}%</div>
      <div>
        <div class="verdict" style="background:${colors[data.verdict]}22;color:${colors[data.verdict]};border:1.5px solid ${colors[data.verdict]}55;">${data.verdict}</div>
        <div class="title">${data.playbook_title || data.filename}</div>
        <div class="summary">${data.summary || ''}</div>
        <div style="font-size:12px;color:#8A9BBD;margin-top:8px;">
          ${data.criteria.filter(c=>c.status==='PRESENTE').length} completos ·
          ${data.criteria.filter(c=>c.status==='PARCIAL').length} parciales ·
          ${data.criteria.filter(c=>c.status==='AUSENTE').length} ausentes
        </div>
      </div>
    </div>
    <div class="section-title">Evaluación por Criterio</div>
    <div class="grid">${criteriaRows}</div>
  </div>
    <div class="section-title" style="margin-top:32px;">Referencias Normativas</div>
    <p style="font-size:12px;color:#4A5568;margin-bottom:14px;line-height:1.6;">
      Los criterios del estándar <strong>PB-META-001</strong> de CartoData están basados en las siguientes normas y marcos internacionales.
      Esta sección es de carácter <em>informativo</em> y tiene como propósito situar cada criterio dentro del ecosistema de mejores prácticas de la industria.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="background:#131E3B;color:white;">
          <th style="padding:8px 12px;text-align:left;border-radius:6px 0 0 0;">#</th>
          <th style="padding:8px 12px;text-align:left;">Criterio</th>
          <th style="padding:8px 12px;text-align:left;border-radius:0 6px 0 0;">Referencia normativa</th>
        </tr>
      </thead>
      <tbody>
        ${data.criteria.map((c, i) => `
        <tr style="background:${i % 2 === 0 ? '#F8FAFC' : '#FFFFFF'};border-bottom:1px solid #EEF2F7;">
          <td style="padding:8px 12px;font-weight:700;color:#4A7EC0;">${c.id}</td>
          <td style="padding:8px 12px;color:#131E3B;">${c.name}</td>
          <td style="padding:8px 12px;color:#3366AA;font-weight:600;">${c.norm || '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div style="margin-top:16px;padding:12px 16px;background:#EBF2FB;border-radius:8px;font-size:11px;color:#3366AA;line-height:1.7;">
      <strong>Normas referenciadas:</strong> ISO 9001:2015 (Gestión de Calidad) · ISO 10013:2021 (Documentación de sistemas de gestión) ·
      ISO/IEC 27001 (Seguridad de la información) · PMBOK Guide 7ª ed. (PMI) · ITIL v4 (Gestión de servicios) ·
      OKR Framework — John Doerr / Google · Toyota Production System (TPS) / Lean · Six Sigma DMAIC · Apple DRI Model ·
      <strong>CartoData Visión 2035</strong>
    </div>
  </div>
  <div class="footer">CartoData — Evaluación automatizada con IA · Estándar PB-META-001</div>
  </body></html>`;
}

/* ── Error handling ── */
function showError(msg) {
  const toast = document.getElementById('error-toast');
  document.getElementById('error-msg').textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 6000);
}

function hideError() {
  document.getElementById('error-toast').classList.add('hidden');
}
