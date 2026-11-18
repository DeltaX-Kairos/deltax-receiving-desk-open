import { extractReceipt } from './firebase.js';
import {
  DRAFT_UNITS,
  validateDraft,
  parseCountsInput,
  formatCountsInput,
  evaluateReceivingBaseline,
  diffDrafts,
} from './policy.js';

const STORAGE_KEY = 'deltax.receivingDesk.draft.v1';

const INITIAL_SAMPLE = Object.freeze({
  poQty: 10,
  note: 'Dock check: counted 8 intact cartons on pallet; 2 short of PO.',
  mode: 'prefer_on_device',
  workingDraft: {
    counts: [8],
    unit: 'cartons',
    conflict: false,
  },
  operatorNotes: '',
});

const state = {
  poQtyRaw: String(INITIAL_SAMPLE.poQty),
  note: INITIAL_SAMPLE.note,
  mode: INITIAL_SAMPLE.mode,
  extractedDraft: null,
  extractionSource: null,
  extractionMeta: null,
  rawMalformedDraft: null,
  workingDraft: {
    counts: [...INITIAL_SAMPLE.workingDraft.counts],
    unit: INITIAL_SAMPLE.workingDraft.unit,
    conflict: INITIAL_SAMPLE.workingDraft.conflict,
  },
  countsInputText: formatCountsInput(INITIAL_SAMPLE.workingDraft.counts),
  countsInvalidTokens: [],
  operatorNotes: INITIAL_SAMPLE.operatorNotes,
  isExtracting: false,
  extractionStatusMessage: 'Ready — initial sample loaded (PO 10, observed 8).',
  persistenceStatus: 'Initial sample loaded',
  persistenceTone: 'neutral',
  savedSnapshotAvailable: false,
};

const dom = {
  recoveryBanner: document.getElementById('recovery-banner'),
  recoverySummary: document.getElementById('recovery-summary'),
  bannerRecoverBtn: document.getElementById('banner-recover-btn'),
  bannerDiscardBtn: document.getElementById('banner-discard-btn'),
  persistencePill: document.getElementById('persistence-pill'),

  intakeForm: document.getElementById('intake-form'),
  poQtyInput: document.getElementById('po-qty'),
  poQtyError: document.getElementById('po-qty-error'),
  inferenceModeSelect: document.getElementById('inference-mode'),
  countNoteInput: document.getElementById('count-note'),
  noteError: document.getElementById('note-error'),
  extractBtn: document.getElementById('extract-btn'),
  resetSampleBtn: document.getElementById('reset-sample-btn'),
  extractionStatus: document.getElementById('extraction-status'),

  revertEditsBtn: document.getElementById('revert-edits-btn'),
  inferenceSourceBadge: document.getElementById('inference-source-badge'),
  inferenceMetaValue: document.getElementById('inference-meta-value'),
  rawValidationBadge: document.getElementById('raw-validation-badge'),
  rawDraftJson: document.getElementById('raw-draft-json'),
  rawExtractionError: document.getElementById('raw-extraction-error'),

  draftCountsInput: document.getElementById('draft-counts'),
  draftCountsError: document.getElementById('draft-counts-error'),
  draftUnitSelect: document.getElementById('draft-unit'),
  draftConflictInput: document.getElementById('draft-conflict'),

  draftDiffPanel: document.getElementById('draft-diff-panel'),
  diffStatusBadge: document.getElementById('diff-status-badge'),
  diffContent: document.getElementById('diff-content'),

  decisionBanner: document.getElementById('decision-banner'),
  decisionBadge: document.getElementById('decision-badge'),
  decisionSupport: document.getElementById('decision-support'),
  decisionSummary: document.getElementById('decision-summary'),

  cmpPo: document.getElementById('cmp-po'),
  cmpObserved: document.getElementById('cmp-observed'),
  cmpVariance: document.getElementById('cmp-variance'),
  cmpUnitConflict: document.getElementById('cmp-unit-conflict'),

  editImpactBox: document.getElementById('edit-impact-box'),
  editImpactText: document.getElementById('edit-impact-text'),

  operatorNotesInput: document.getElementById('operator-notes'),
  saveDraftBtn: document.getElementById('save-draft-btn'),
  recoverDraftBtn: document.getElementById('recover-draft-btn'),
  clearDraftBtn: document.getElementById('clear-draft-btn'),

  candidatesList: document.getElementById('candidates-list'),

  reloadBenchmarkBtn: document.getElementById('reload-benchmark-btn'),
  replayContainer: document.getElementById('replay-container'),
};

function createEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatTimeLabel(isoString) {
  if (!isoString) return 'unknown time';
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) return String(isoString);
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function cloneDraft(draft) {
  return {
    counts: [...draft.counts],
    unit: draft.unit,
    conflict: draft.conflict,
  };
}

function getParsedPoQty() {
  const trimmed = String(state.poQtyRaw ?? '').trim();
  if (!trimmed) return Number.NaN;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function getActiveWorkingDraftForPolicy() {
  if (state.countsInvalidTokens.length > 0) {
    return null;
  }
  return state.workingDraft;
}

function readSavedDraft() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const workingValidation = validateDraft(parsed.workingDraft);
    if (!workingValidation.valid) return null;

    const extractedValidation =
      parsed.extractedDraft !== null && parsed.extractedDraft !== undefined
        ? validateDraft(parsed.extractedDraft)
        : null;

    return {
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
      poQtyRaw: typeof parsed.poQtyRaw === 'string' ? parsed.poQtyRaw : String(INITIAL_SAMPLE.poQty),
      note: typeof parsed.note === 'string' ? parsed.note : '',
      mode: typeof parsed.mode === 'string' ? parsed.mode : INITIAL_SAMPLE.mode,
      extractedDraft: extractedValidation?.valid ? extractedValidation.normalized : null,
      extractionSource:
        typeof parsed.extractionSource === 'string' ? parsed.extractionSource : null,
      extractionMeta:
        parsed.extractionMeta && typeof parsed.extractionMeta === 'object'
          ? parsed.extractionMeta
          : null,
      workingDraft: workingValidation.normalized,
      countsInputText:
        typeof parsed.countsInputText === 'string'
          ? parsed.countsInputText
          : formatCountsInput(workingValidation.normalized.counts),
      operatorNotes: typeof parsed.operatorNotes === 'string' ? parsed.operatorNotes : '',
    };
  } catch {
    return null;
  }
}

function persistCurrentDraft(explicitLabel = null) {
  const savedAt = new Date().toISOString();
  const payload = {
    version: 1,
    savedAt,
    poQtyRaw: state.poQtyRaw,
    note: state.note,
    mode: state.mode,
    extractedDraft: state.extractedDraft,
    extractionSource: state.extractionSource,
    extractionMeta: state.extractionMeta,
    workingDraft: state.workingDraft,
    countsInputText: state.countsInputText,
    operatorNotes: state.operatorNotes,
  };

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    state.savedSnapshotAvailable = true;
    state.persistenceStatus = explicitLabel || `Saved locally at ${formatTimeLabel(savedAt)}`;
    state.persistenceTone = 'saved';
  } catch {
    state.persistenceStatus = 'Local storage unavailable';
    state.persistenceTone = 'warn';
  }
}

function clearSavedDraft() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors cleanly
  }
  state.savedSnapshotAvailable = false;
  state.persistenceStatus = 'Saved draft cleared';
  state.persistenceTone = 'neutral';
  dom.recoveryBanner.hidden = true;
}

function recoverSavedDraft() {
  const saved = readSavedDraft();
  if (!saved) {
    state.savedSnapshotAvailable = false;
    state.persistenceStatus = 'No valid saved draft found';
    state.persistenceTone = 'warn';
    dom.recoveryBanner.hidden = true;
    renderAll();
    return;
  }

  state.poQtyRaw = saved.poQtyRaw;
  state.note = saved.note;
  state.mode = saved.mode;
  state.extractedDraft = saved.extractedDraft ? cloneDraft(saved.extractedDraft) : null;
  state.extractionSource = saved.extractionSource;
  state.extractionMeta = saved.extractionMeta;
  state.rawMalformedDraft = null;
  state.workingDraft = cloneDraft(saved.workingDraft);
  state.countsInputText = saved.countsInputText;
  state.countsInvalidTokens = parseCountsInput(saved.countsInputText).invalidTokens;
  state.operatorNotes = saved.operatorNotes;
  state.extractionStatusMessage = `Recovered local draft saved at ${formatTimeLabel(saved.savedAt)}.`;
  state.persistenceStatus = `Recovered draft (${formatTimeLabel(saved.savedAt)})`;
  state.persistenceTone = 'saved';
  dom.recoveryBanner.hidden = true;

  syncInputsFromState();
  renderAll();
}

function resetToInitialSample() {
  state.poQtyRaw = String(INITIAL_SAMPLE.poQty);
  state.note = INITIAL_SAMPLE.note;
  state.mode = INITIAL_SAMPLE.mode;
  state.extractedDraft = null;
  state.extractionSource = null;
  state.extractionMeta = null;
  state.rawMalformedDraft = null;
  state.workingDraft = cloneDraft(INITIAL_SAMPLE.workingDraft);
  state.countsInputText = formatCountsInput(INITIAL_SAMPLE.workingDraft.counts);
  state.countsInvalidTokens = [];
  state.operatorNotes = '';
  state.extractionStatusMessage = 'Reset to initial sample (PO 10, observed 8).';
  state.persistenceStatus = 'Initial sample (unsaved)';
  state.persistenceTone = 'neutral';

  syncInputsFromState();
  renderAll();
}

function syncInputsFromState() {
  dom.poQtyInput.value = state.poQtyRaw;
  dom.countNoteInput.value = state.note;
  dom.inferenceModeSelect.value = state.mode;
  dom.draftCountsInput.value = state.countsInputText;
  dom.draftUnitSelect.value = DRAFT_UNITS.includes(state.workingDraft.unit)
    ? state.workingDraft.unit
    : 'unknown';
  dom.draftConflictInput.checked = Boolean(state.workingDraft.conflict);
  dom.operatorNotesInput.value = state.operatorNotes;
}

function renderSourceBadge(source) {
  dom.inferenceSourceBadge.className = 'source-badge';
  if (!source) {
    dom.inferenceSourceBadge.classList.add('source-pending');
    dom.inferenceSourceBadge.textContent = 'Not yet extracted';
    return;
  }

  const normalized = String(source).toLowerCase();
  if (normalized.includes('device')) {
    dom.inferenceSourceBadge.classList.add('source-on-device');
  } else if (normalized.includes('cloud')) {
    dom.inferenceSourceBadge.classList.add('source-cloud');
  } else if (normalized.includes('error') || normalized.includes('fail') || normalized.includes('unavail')) {
    dom.inferenceSourceBadge.classList.add('source-error');
  } else {
    dom.inferenceSourceBadge.classList.add('source-pending');
  }
  dom.inferenceSourceBadge.textContent = source;
}

function renderExtractionAndDiff() {
  renderSourceBadge(state.extractionSource);

  const metaParts = [];
  if (state.extractionMeta?.model) metaParts.push(`model: ${state.extractionMeta.model}`);
  if (typeof state.extractionMeta?.elapsedMs === 'number') {
    metaParts.push(`${state.extractionMeta.elapsedMs} ms`);
  }
  dom.inferenceMetaValue.textContent = metaParts.length > 0 ? metaParts.join(' · ') : '—';

  if (state.extractionMeta?.error) {
    dom.rawValidationBadge.className = 'pill pill-error';
    dom.rawValidationBadge.textContent = 'Error / Malformed';
    dom.rawExtractionError.hidden = false;
    dom.rawExtractionError.textContent = state.extractionMeta.error;
    if (typeof state.rawMalformedDraft === 'string') {
      dom.rawDraftJson.textContent = state.rawMalformedDraft;
    } else if (state.rawMalformedDraft) {
      dom.rawDraftJson.textContent = JSON.stringify(state.rawMalformedDraft, null, 2);
    } else {
      dom.rawDraftJson.textContent = 'Extraction did not produce a valid draft.';
    }
  } else if (state.extractedDraft) {
    dom.rawValidationBadge.className = 'pill pill-saved';
    dom.rawValidationBadge.textContent = 'Valid Contract';
    dom.rawExtractionError.hidden = true;
    dom.rawExtractionError.textContent = '';
    dom.rawDraftJson.textContent = JSON.stringify(state.extractedDraft, null, 2);
  } else {
    dom.rawValidationBadge.className = 'pill pill-neutral';
    dom.rawValidationBadge.textContent = 'Pending';
    dom.rawExtractionError.hidden = true;
    dom.rawExtractionError.textContent = '';
    dom.rawDraftJson.textContent =
      'No Firebase extraction run yet. Working draft below starts on the initial sample (PO 10, observed 8).';
  }

  const diff = diffDrafts(
    state.extractedDraft,
    state.countsInvalidTokens.length > 0 ? null : state.workingDraft,
  );

  dom.revertEditsBtn.disabled = !state.extractedDraft || !diff.changed;
  dom.diffContent.replaceChildren();

  if (!diff.hasBaselineExtraction) {
    dom.draftDiffPanel.classList.remove('diff-active');
    dom.diffStatusBadge.className = 'pill pill-neutral';
    dom.diffStatusBadge.textContent = 'No extraction yet';
    dom.diffContent.appendChild(
      createEl(
        'p',
        'field-hint',
        'Run Firebase extraction to establish an immutable extraction baseline for comparison. Currently assessing the editable working draft directly.',
      ),
    );
    return;
  }

  if (!diff.changed) {
    dom.draftDiffPanel.classList.remove('diff-active');
    dom.diffStatusBadge.className = 'pill pill-saved';
    dom.diffStatusBadge.textContent = 'Unmodified extraction (0 edits)';
    dom.diffContent.appendChild(
      createEl('p', 'field-hint', 'Operator working draft matches the raw Firebase extraction.'),
    );
    return;
  }

  dom.draftDiffPanel.classList.add('diff-active');
  dom.diffStatusBadge.className = 'pill pill-warn';
  dom.diffStatusBadge.textContent = `Operator edited (${diff.changeCount} change${diff.changeCount === 1 ? '' : 's'})`;

  const list = createEl('ul', 'diff-list');
  for (const change of diff.changes) {
    const item = document.createElement('li');
    item.appendChild(createEl('strong', null, `${change.label}: `));
    item.appendChild(createEl('span', 'diff-before mono-value', change.before));
    item.appendChild(document.createTextNode(' → '));
    item.appendChild(createEl('span', 'diff-after mono-value', change.after));
    list.appendChild(item);
  }
  dom.diffContent.appendChild(list);
}

function renderAssessment() {
  const poQty = getParsedPoQty();
  const poValid = Number.isFinite(poQty) && poQty > 0;
  dom.poQtyInput.setAttribute('aria-invalid', String(!poValid));
  if (!poValid) {
    dom.poQtyError.hidden = false;
    dom.poQtyError.textContent = 'Enter a positive PO quantity (> 0) to evaluate full or partial receipt.';
  } else {
    dom.poQtyError.hidden = true;
    dom.poQtyError.textContent = '';
  }

  if (state.countsInvalidTokens.length > 0) {
    dom.draftCountsInput.setAttribute('aria-invalid', 'true');
    dom.draftCountsError.hidden = false;
    dom.draftCountsError.textContent = `Invalid non-negative number token(s): ${state.countsInvalidTokens.join(', ')}`;
  } else {
    dom.draftCountsInput.setAttribute('aria-invalid', 'false');
    dom.draftCountsError.hidden = true;
    dom.draftCountsError.textContent = '';
  }

  const activeDraft = getActiveWorkingDraftForPolicy();
  const assessment = evaluateReceivingBaseline(poQty, activeDraft);

  dom.decisionBanner.className = `decision-banner decision-${assessment.action}`;
  dom.decisionBadge.textContent = assessment.label.toUpperCase();
  dom.decisionSupport.textContent = `Support: ${assessment.support.toFixed(2)}`;
  dom.decisionSummary.textContent = assessment.summary;

  dom.cmpPo.textContent = assessment.evidence.poValid ? String(assessment.evidence.poQty) : 'Invalid';

  if (!assessment.evidence.draftValid) {
    dom.cmpObserved.textContent = 'Invalid draft';
    dom.cmpVariance.textContent = '—';
    dom.cmpUnitConflict.textContent = 'Draft validation error';
  } else {
    if (assessment.evidence.countEntries === 0) {
      dom.cmpObserved.textContent = 'Missing (none)';
    } else if (assessment.evidence.countEntries > 1) {
      dom.cmpObserved.textContent = `Unresolved (${assessment.evidence.counts.join(', ')})`;
    } else {
      dom.cmpObserved.textContent = String(assessment.evidence.observedCount);
    }

    if (assessment.evidence.delta === null) {
      dom.cmpVariance.textContent = '—';
    } else if (assessment.evidence.delta === 0) {
      dom.cmpVariance.textContent = '0 (exact match)';
    } else if (assessment.evidence.delta < 0) {
      const pct = Math.round(assessment.evidence.fulfillmentRatio * 100);
      dom.cmpVariance.textContent = `${assessment.evidence.delta} (${pct}% of PO)`;
    } else {
      dom.cmpVariance.textContent = `+${assessment.evidence.delta} (overage)`;
    }

    dom.cmpUnitConflict.textContent = `${assessment.evidence.unit} · ${
      assessment.evidence.conflict ? 'conflict flagged' : 'no conflict'
    }`;
  }

  // Show edit impact when an extraction baseline exists and operator modified the working draft
  const diff = diffDrafts(state.extractedDraft, activeDraft);
  if (diff.hasBaselineExtraction && diff.changed) {
    const rawAssessment = evaluateReceivingBaseline(poQty, state.extractedDraft);
    dom.editImpactBox.hidden = false;
    if (rawAssessment.action !== assessment.action) {
      dom.editImpactText.textContent = `Baseline decision changed from ${rawAssessment.label} (raw extraction) to ${assessment.label} (operator-edited draft).`;
    } else {
      dom.editImpactText.textContent = `Baseline decision remains ${assessment.label} after operator edits (raw extraction also yielded ${rawAssessment.label}).`;
    }
  } else {
    dom.editImpactBox.hidden = true;
    dom.editImpactText.textContent = '';
  }

  // Render all 3 support-scored candidates
  dom.candidatesList.replaceChildren();
  for (const candidate of assessment.candidates) {
    const card = createEl(
      'article',
      `candidate-card${candidate.supported ? ' candidate-supported' : ''}`,
    );

    const top = createEl('div', 'candidate-top');
    const titleGroup = createEl('div', 'candidate-title-group');
    titleGroup.appendChild(createEl('strong', null, candidate.label));
    titleGroup.appendChild(
      createEl(
        'span',
        `pill ${candidate.supported ? 'pill-saved' : 'pill-neutral'}`,
        candidate.supported ? 'Supported' : 'Blocked',
      ),
    );

    const scoreGroup = createEl('div', 'candidate-score-group');
    const bar = createEl('div', 'support-bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = createEl('div', 'support-bar-fill');
    fill.style.width = `${Math.round(candidate.support * 100)}%`;
    bar.appendChild(fill);
    scoreGroup.appendChild(bar);
    scoreGroup.appendChild(createEl('span', 'mono-value', candidate.support.toFixed(2)));

    top.appendChild(titleGroup);
    top.appendChild(scoreGroup);
    card.appendChild(top);

    const details = createEl('ul', 'candidate-reasons');
    const messages = candidate.reasons.length > 0 ? candidate.reasons : candidate.blockers;
    for (const msg of messages) {
      details.appendChild(createEl('li', null, msg));
    }
    card.appendChild(details);
    dom.candidatesList.appendChild(card);
  }
}

function renderPersistenceControls() {
  dom.persistencePill.className = `pill pill-${state.persistenceTone}`;
  dom.persistencePill.textContent = state.persistenceStatus;
  dom.recoverDraftBtn.disabled = !state.savedSnapshotAvailable;
  dom.clearDraftBtn.disabled = !state.savedSnapshotAvailable;
  dom.extractionStatus.textContent = state.extractionStatusMessage;
}

function renderAll() {
  renderExtractionAndDiff();
  renderAssessment();
  renderPersistenceControls();
}

async function handleExtractSubmit(event) {
  event.preventDefault();
  if (state.isExtracting) return;

  const trimmedNote = state.note.trim();
  if (!trimmedNote || trimmedNote.length > 3000) {
    dom.countNoteInput.setAttribute('aria-invalid', 'true');
    dom.noteError.hidden = false;
    dom.noteError.textContent = !trimmedNote
      ? 'Enter a carton count note before running Firebase extraction.'
      : 'Receiving note must be 3,000 characters or fewer.';
    dom.countNoteInput.focus();
    return;
  }

  dom.countNoteInput.setAttribute('aria-invalid', 'false');
  dom.noteError.hidden = true;
  dom.noteError.textContent = '';

  state.isExtracting = true;
  dom.extractBtn.disabled = true;
  state.extractionStatusMessage = `Extracting via Firebase (${state.mode})...`;
  renderPersistenceControls();

  const startedAt = performance.now();

  try {
    const result = await extractReceipt(trimmedNote, state.mode);
    if (state.note.trim() !== trimmedNote) return;
    const elapsedMs =
      typeof result?.elapsedMs === 'number'
        ? Math.round(result.elapsedMs)
        : Math.round(performance.now() - startedAt);

    const source =
      typeof result?.source === 'string' && result.source.trim()
        ? result.source.trim()
        : 'unknown';

    const validation = validateDraft(result?.draft);

    state.extractionSource = source;
    state.extractionMeta = {
      model: typeof result?.model === 'string' ? result.model : null,
      elapsedMs,
      error: typeof result?.error === 'string' ? result.error : null,
    };

    if (validation.valid) {
      state.extractedDraft = cloneDraft(validation.normalized);
      state.rawMalformedDraft = null;
      state.workingDraft = cloneDraft(validation.normalized);
      state.countsInputText = formatCountsInput(validation.normalized.counts);
      state.countsInvalidTokens = [];
      state.extractionStatusMessage = `Extracted via ${source} in ${elapsedMs} ms.`;
    } else {
      state.extractedDraft = null;
      state.rawMalformedDraft = result?.draft ?? result ?? null;
      state.extractionMeta.error =
        state.extractionMeta.error ||
        `Malformed extractor draft: ${validation.errors.join(' ')}`;
      state.workingDraft = { counts: [], unit: 'unknown', conflict: false };
      state.countsInputText = '';
      state.countsInvalidTokens = [];
      state.extractionStatusMessage = `Extraction from ${source} returned malformed draft — held for review.`;
    }
  } catch (err) {
    if (state.note.trim() !== trimmedNote) return;
    const elapsedMs = Math.round(performance.now() - startedAt);
    const errSource =
      err && typeof err === 'object' && typeof err.source === 'string' && err.source.trim()
        ? err.source.trim()
        : 'error';
    const errRaw =
      err && typeof err === 'object' && err.raw !== undefined ? err.raw : null;

    state.extractionSource = errSource;
    state.extractedDraft = null;
    state.rawMalformedDraft = errRaw;
    state.extractionMeta = {
      model: null,
      elapsedMs,
      error: err?.source ? 'The model returned an invalid observation.' : 'Firebase could not return a draft. Check model availability, App Check, and project quota.',
    };
    state.workingDraft = { counts: [], unit: 'unknown', conflict: false };
    state.countsInputText = '';
    state.countsInvalidTokens = [];
    state.extractionStatusMessage =
      errSource === 'error'
        ? `Firebase extraction failed (${elapsedMs} ms) — held safely.`
        : `Extraction from ${errSource} failed validation (${elapsedMs} ms) — held safely.`;
  } finally {
    state.isExtracting = false;
    dom.extractBtn.disabled = false;
    syncInputsFromState();
    persistCurrentDraft();
    renderAll();
  }
}

function renderReplayUnavailable(reasonText) {
  dom.replayContainer.replaceChildren();
  const box = createEl('div', 'unavailable-box');
  box.appendChild(createEl('strong', null, 'Hosted replay unavailable'));
  box.appendChild(createEl('p', null, reasonText));
  box.appendChild(
    createEl(
      'p',
      null,
      'Live deterministic baseline assessment above operates independently without inventing hosted replay rows.',
    ),
  );
  dom.replayContainer.appendChild(box);
}

function extractCaseRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['rows', 'cases', 'results', 'records', 'runs', 'entries']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function renderReplayData(payload) {
  const rows = extractCaseRows(payload);
  const summaryObj =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload.summary || payload.metrics || null
      : null;

  if (rows.length === 0 && !summaryObj) {
    renderReplayUnavailable(
      'data/benchmark.json loaded but contained no replay records or summary metrics.',
    );
    return;
  }

  dom.replayContainer.replaceChildren();

  if (summaryObj && typeof summaryObj === 'object') {
    const grid = createEl('dl', 'replay-summary-grid');
    for (const [key, value] of Object.entries(summaryObj)) {
      if (value === null || typeof value === 'object') continue;
      if (key.toLowerCase().includes('expected') || key.toLowerCase().includes('gold')) continue;
      const box = createEl('div', 'metric-box');
      box.appendChild(createEl('dt', null, key));
      box.appendChild(createEl('dd', 'mono-value', String(value)));
      grid.appendChild(box);
    }
    if (grid.childElementCount > 0) {
      dom.replayContainer.appendChild(grid);
    }
  }

  if (rows.length === 0) return;

  const scrollWrap = createEl('div', 'table-scroll');
  const table = createEl('table', 'replay-table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of [
    'Case',
    'PO Qty',
    'Inference Source',
    'Expected',
    'Extracted Draft',
    'Baseline (policy.js)',
    'Hosted Outcome',
    'Extraction time',
  ]) {
    headerRow.appendChild(createEl('th', null, label));
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    const caseId = row.id ?? row.caseId ?? `#${index + 1}`;
    const poQty = Number(row.poQty ?? row.orderedQty ?? row.po ?? NaN);
    const source = row.source ?? (row.route ? row.route + ' · failed' : '—');
    const expected = row.expected ?? '—';
    const rawDraft = row.draft ?? row.extraction ?? row.rawExtraction ?? null;
    const hostedOutcome = row.error
      ? `ERROR: ${row.error}`
      : row.hostedDecision ?? row.decision ?? row.status ?? '—';
    const latency =
      typeof row.elapsedMs === 'number'
        ? `${Math.round(row.elapsedMs)} ms`
        : typeof row.latencyMs === 'number'
          ? `${Math.round(row.latencyMs)} ms`
          : '—';

    const baseline = row.baseline ?? (rawDraft ? evaluateReceivingBaseline(poQty, rawDraft).action : 'unavailable');

    const caseCell = createEl('td', 'mono-value', caseId);
    if (rawDraft && row.note) {
      const review = createEl('button', 'btn btn-secondary btn-sm', 'Review ' + caseId);
      review.type = 'button';
      review.addEventListener('click', () => {
        state.poQtyRaw = String(poQty);
        state.note = row.note;
        state.extractedDraft = cloneDraft(rawDraft);
        state.workingDraft = cloneDraft(rawDraft);
        state.countsInputText = formatCountsInput(rawDraft.counts);
        state.countsInvalidTokens = [];
        state.extractionSource = 'Recorded · ' + source;
        state.extractionStatusMessage = 'Reviewing recorded case ' + caseId;
        state.extractionMeta = {elapsedMs:row.elapsedMs, model:null, error:null};
        state.rawMalformedDraft = null;
        state.operatorNotes = '';
        syncInputsFromState();
        renderAll();
        dom.countNoteInput.focus();
      });
      caseCell.replaceChildren(review);
    }
    tr.appendChild(caseCell);
    tr.appendChild(createEl('td', 'mono-value', Number.isFinite(poQty) ? String(poQty) : '—'));
    tr.appendChild(createEl('td', 'mono-value', source));
    tr.appendChild(createEl('td', 'mono-value', expected));
    tr.appendChild(
      createEl('td', 'mono-value', rawDraft ? JSON.stringify(rawDraft) : 'none / malformed'),
    );
    tr.appendChild(createEl('td', 'mono-value', baseline));
    tr.appendChild(createEl('td', 'mono-value', hostedOutcome));
    tr.appendChild(createEl('td', 'mono-value', latency));
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  scrollWrap.appendChild(table);
  dom.replayContainer.appendChild(scrollWrap);
}

async function loadBenchmarkReplay() {
  dom.replayContainer.replaceChildren(
    createEl('p', 'field-hint', 'Checking for optional data/benchmark.json...'),
  );

  try {
    const response = await fetch('./data/benchmark.json', { cache: 'no-store' });
    if (!response.ok) {
      renderReplayUnavailable(
        `data/benchmark.json is not present or returned HTTP ${response.status}.`,
      );
      return;
    }

    const payload = await response.json();
    renderReplayData(payload);
  } catch (err) {
    renderReplayUnavailable(
      `Could not load data/benchmark.json (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

function bindEvents() {
  dom.intakeForm.addEventListener('submit', handleExtractSubmit);

  dom.poQtyInput.addEventListener('input', (event) => {
    state.poQtyRaw = event.target.value;
    persistCurrentDraft();
    renderAll();
  });

  dom.countNoteInput.addEventListener('input', (event) => {
    state.note = event.target.value;
    state.extractedDraft = null;
    state.extractionMeta = null;
    state.rawMalformedDraft = null;
    state.extractionSource = null;
    state.workingDraft = {counts: [], unit: 'unknown', conflict: false};
    state.countsInputText = '';
    state.countsInvalidTokens = [];
    state.extractionStatusMessage = 'Note changed. Extract it or enter a physical count.';
    syncInputsFromState();
    renderAll();
    if (state.note.trim()) {
      dom.countNoteInput.setAttribute('aria-invalid', 'false');
      dom.noteError.hidden = true;
    }
    persistCurrentDraft();
    renderPersistenceControls();
  });

  dom.inferenceModeSelect.addEventListener('change', (event) => {
    state.mode = event.target.value;
    persistCurrentDraft();
    renderPersistenceControls();
  });

  dom.draftCountsInput.addEventListener('input', (event) => {
    state.countsInputText = event.target.value;
    const parsed = parseCountsInput(state.countsInputText);
    state.countsInvalidTokens = parsed.invalidTokens;
    if (parsed.invalidTokens.length === 0) {
      state.workingDraft.counts = parsed.counts;
    }
    persistCurrentDraft();
    renderAll();
  });

  dom.draftUnitSelect.addEventListener('change', (event) => {
    const val = event.target.value;
    state.workingDraft.unit = DRAFT_UNITS.includes(val) ? val : 'unknown';
    persistCurrentDraft();
    renderAll();
  });

  dom.draftConflictInput.addEventListener('change', (event) => {
    state.workingDraft.conflict = Boolean(event.target.checked);
    persistCurrentDraft();
    renderAll();
  });

  dom.operatorNotesInput.addEventListener('input', (event) => {
    state.operatorNotes = event.target.value;
    persistCurrentDraft();
    renderPersistenceControls();
  });

  dom.revertEditsBtn.addEventListener('click', () => {
    if (!state.extractedDraft) return;
    state.workingDraft = cloneDraft(state.extractedDraft);
    state.countsInputText = formatCountsInput(state.workingDraft.counts);
    state.countsInvalidTokens = [];
    syncInputsFromState();
    persistCurrentDraft();
    renderAll();
  });

  dom.resetSampleBtn.addEventListener('click', resetToInitialSample);

  dom.saveDraftBtn.addEventListener('click', () => {
    persistCurrentDraft(`Saved locally at ${formatTimeLabel(new Date().toISOString())}`);
    renderPersistenceControls();
  });

  dom.recoverDraftBtn.addEventListener('click', recoverSavedDraft);
  dom.bannerRecoverBtn.addEventListener('click', recoverSavedDraft);

  dom.clearDraftBtn.addEventListener('click', () => {
    clearSavedDraft();
    renderPersistenceControls();
  });
  dom.bannerDiscardBtn.addEventListener('click', () => {
    clearSavedDraft();
    renderPersistenceControls();
  });

  dom.reloadBenchmarkBtn.addEventListener('click', loadBenchmarkReplay);
}

function init() {
  const existingSaved = readSavedDraft();
  if (existingSaved) {
    state.savedSnapshotAvailable = true;
    const notePreview = existingSaved.note
      ? existingSaved.note.slice(0, 64) + (existingSaved.note.length > 64 ? '…' : '')
      : 'empty note';
    dom.recoverySummary.textContent = `Saved ${formatTimeLabel(existingSaved.savedAt)} · PO ${existingSaved.poQtyRaw || '?'} · "${notePreview}"`;
    dom.recoveryBanner.hidden = false;
  }

  if (!import.meta.env.VITE_FIREBASE_CONFIG) {
    dom.inferenceModeSelect.querySelector('[value="prefer_on_device"]').disabled = true;
    state.mode = 'only_on_device';
    document.getElementById('mode-hint').textContent = 'This build uses Chrome’s on-device model. See the project README to configure Firebase cloud fallback.';
  }
  syncInputsFromState();
  bindEvents();
  renderAll();
  loadBenchmarkReplay();
}

init();
