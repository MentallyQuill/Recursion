import { normalizePostProcessWriter, normalizePostProcessStyle, validatePostProcessWriter } from '../post-process-editing.mjs';

// Return text segments only. Rendering always uses textContent, never generated HTML.
export function buildRevisionDiff(original, revised) {
  const before = String(original ?? '');
  const after = String(revised ?? '');
  if (before === after) return { original: [{ text: before, changed: false }], revised: [{ text: after, changed: false }], coarse: false };
  const coarse = before.length + after.length > 40000;
  const split = (text) => coarse ? text.split(/(?<=\n)/u) : (text.match(/\s+|[^\s]+/gu) || []);
  const a = split(before), b = split(after);
  // Bound both memory and comparisons; large texts use common paragraph edges.
  if (coarse || a.length * b.length > 160000 || a.length + b.length > 3000) {
    let start = 0, end = 0;
    while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
    while (end < Math.min(a.length, b.length) - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    const parts = (items) => [
      { text: items.slice(0, start).join(''), changed: false },
      { text: items.slice(start, items.length - end).join(''), changed: true },
      { text: end ? items.slice(-end).join('') : '', changed: false }
    ].filter(part => part.text);
    return { original: parts(a), revised: parts(b), coarse: true };
  }
  const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  }
  const result = { original: [], revised: [], coarse: false };
  const add = (side, text, changed) => {
    const last = result[side].at(-1);
    if (last?.changed === changed) last.text += text;
    else result[side].push({ text, changed });
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { add('original', a[i++], false); add('revised', b[j++], false); }
    else if (i < a.length && (j === b.length || rows[i + 1][j] >= rows[i][j + 1])) add('original', a[i++], true);
    else add('revised', b[j++], true);
  }
  return result;
}

export function renderPostProcessWritingControls({ el, settings = {}, status = null, deck, profiles = [], onSettings, onStyle, onCopy, onReview, onImport, onExport, onError }) {
  const writer = normalizePostProcessWriter(settings.writer);
  const field = (tag, key, label, value, attrs = {}) => {
    const node = el(tag, { className: 'recursion-input', attrs: { 'aria-label': label, ...attrs }, dataset: { [key]: '' } });
    node.value = value ?? '';
    return node;
  };
  const row = (label, control) => el('label', { className: 'recursion-post-process-writing-row' }, [el('span', { text: label }), control]);
  const select = (key, label, value, entries) => {
    const node = field('select', key, label, value);
    for (const [id, text] of entries) node.appendChild(el('option', { text, attrs: { value: id, ...(id === value ? { selected: '' } : {}) } }));
    node.value = value;
    return node;
  };
  const action = (key, label, callback) => {
    const node = el('button', { className: 'recursion-button', text: label, attrs: { type: 'button' }, dataset: { [key]: '' } });
    node.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); callback(); });
    return node;
  };
  const applyWriter = (patch) => {
    try { onSettings({ writer: validatePostProcessWriter({ ...writer, ...patch }) }); }
    catch (error) { onError(error.message); }
  };
  const mode = select('recursionPostProcessWriterMode', 'Writer', writer.mode, [['native', 'Current SillyTavern model'], ['profile', 'Connection Profile']]);
  mode.addEventListener('change', () => {
    const connectionProfileId = profiles.find(profile => profile.id === writer.connectionProfileId)?.id || profiles.find(profile => profile.id)?.id || '';
    if (mode.value === 'profile' && !connectionProfileId) {
      mode.value = writer.mode;
      onError('Create a Connection Profile in SillyTavern, then select it here.');
      return;
    }
    applyWriter({ mode: mode.value, ...(mode.value === 'profile' ? { connectionProfileId } : {}) });
  });
  const scope = select('recursionPostProcessEditingScope', 'Editing scope', settings.editingScope || 'polish', [['polish', 'Polish'], ['revise', 'Revise']]);
  scope.addEventListener('change', () => onSettings({ editingScope: scope.value }));
  const review = field('input', 'recursionPostProcessReviewBeforeApplying', 'Review before applying', '', { type: 'checkbox' });
  review.checked = settings.reviewBeforeApplying === true;
  review.addEventListener('change', () => onSettings({ reviewBeforeApplying: review.checked }));
  const shell = el('section', { className: 'recursion-post-process-writing', attrs: { 'aria-label': 'Post-process writing' } }, [row('Writer', mode)]);
  const outcomeText = {
    running: 'Preparing revision...', writing: 'Writing revision...',
    'awaiting-review': 'Ready for review. Open Compare / Review revisions to use the revision.',
    applied: 'Revision applied.', 'no-change': 'No changes needed. Original kept.',
    canceled: 'Canceled. Original kept.',
    failed: status?.failure?.message || 'Post-process failed. Original kept. Open Progress to retry the failed step.'
  }[status?.status];
  if (outcomeText) shell.appendChild(el('p', {
    className: 'recursion-post-process-help recursion-post-process-outcome',
    text: outcomeText, attrs: { role: 'status' },
    dataset: { recursionPostProcessStatus: status.status }
  }));
  if (writer.mode === 'profile') {
    const entries = profiles.map(profile => [profile.id, profile.label || profile.name || 'Connection Profile']);
    if (writer.connectionProfileId && !entries.some(([id]) => id === writer.connectionProfileId)) entries.push([writer.connectionProfileId, 'Unavailable saved profile']);
    const profile = select('recursionPostProcessWriterProfile', 'Writer Connection Profile', writer.connectionProfileId, [['', 'Select a profile'], ...entries]);
    profile.addEventListener('change', () => applyWriter({ connectionProfileId: profile.value }));
    shell.appendChild(row('Connection Profile', profile));
    const advanced = el('details', { dataset: { recursionPostProcessWriterAdvanced: '' } }, [el('summary', { text: 'Advanced writer settings' })]);
    const limit = field('input', 'recursionPostProcessWriterLimit', 'Writer output token limit', writer.maxOutputTokens, { type: 'number', min: 256, max: 65536, step: 1, placeholder: 'Inherit profile' });
    limit.addEventListener('change', () => applyWriter({ maxOutputTokens: limit.value === '' ? null : Number(limit.value) }));
    advanced.appendChild(row('Output token limit', limit));
    const sampling = select('recursionPostProcessWriterSampling', 'Writer sampling', writer.samplerMode, [['profile', 'Profile'], ['override', 'Override']]);
    sampling.addEventListener('change', () => applyWriter({ samplerMode: sampling.value }));
    advanced.appendChild(row('Sampling', sampling));
    if (writer.samplerMode === 'override') for (const [name, label, max] of [['temperature', 'Temperature', 2], ['topP', 'Top-p', 1]]) {
      const node = field('input', name === 'topP' ? 'recursionPostProcessWriterTopP' : 'recursionPostProcessWriterTemperature', label, writer.samplerOverrides[name], { type: 'number', min: 0, max, step: 0.01 });
      node.addEventListener('change', () => applyWriter({ samplerOverrides: { ...writer.samplerOverrides, [name]: node.value === '' ? NaN : Number(node.value) } }));
      advanced.appendChild(row(label, node));
    }
    advanced.appendChild(el('p', { className: 'recursion-post-process-help', text: 'The profile receives the full draft and bounded editing evidence, not the entire native host prompt. Evidence Messages is under Options → Advanced. Overrides apply only to this writer.' }));
    shell.appendChild(advanced);
  }
  shell.appendChild(row('Editing scope', scope));
  shell.appendChild(el('p', { className: 'recursion-post-process-help', text: settings.editingScope === 'revise' ? 'Revise may restructure narration and rephrase dialogue, preserving events and intent.' : 'Polish improves narration while preserving spoken dialogue wording and events.' }));
  shell.appendChild(row('Review before applying', review));
  const style = el('details', { dataset: { recursionPostProcessStyleDetails: '' } }, [el('summary', { text: 'Deck Style' })]);
  const brief = field('textarea', 'recursionPostProcessStyleBrief', 'Style brief (2000 characters maximum)', deck.styleBrief, { rows: 3, ...(deck.readonly ? { readonly: '' } : {}) });
  const sample = field('textarea', 'recursionPostProcessStyleSample', 'Style sample (6000 characters maximum)', deck.styleSample, { rows: 4, ...(deck.readonly ? { readonly: '' } : {}) });
  brief.defaultValue = brief.value;
  sample.defaultValue = sample.value;
  style.appendChild(row('Style brief', brief));
  style.appendChild(row('Example style', sample));
  style.appendChild(el('p', { className: 'recursion-post-process-help', text: 'Brief: up to 2000 characters. Example: up to 6000. Examples guide rhythm and texture; their facts and phrases are not imported.' }));
  if (deck.readonly) style.appendChild(action('recursionPostProcessStyleCopy', 'Copy deck to customize style', onCopy));
  else style.appendChild(action('recursionPostProcessStyleSave', 'Save deck style', () => {
    try { onStyle(normalizePostProcessStyle({ styleBrief: brief.value, styleSample: sample.value })); }
    catch (error) { onError(error.message); }
  }));
  shell.appendChild(style);
  shell.appendChild(el('div', { className: 'recursion-post-process-writing-actions' }, [
    action('recursionPostProcessReview', 'Compare / Review revisions', onReview),
    action('recursionPostProcessDeckImport', 'Import deck', onImport),
    action('recursionPostProcessDeckExport', 'Export deck', onExport)
  ]));
  return shell;
}

export function createPostProcessReviewDialog({ runtime, document = globalThis.document, onError = () => {} } = {}) {
  let dialog = null, selectedId = '', records = [], busy = false, editing = false, highlighted = true;
  let opener = null, scrollPositions = [], request = 0, unsubscribe = null;
  const node = (tag, text = '', className = '') => {
    const result = document.createElement(tag); result.textContent = text; result.className = className; return result;
  };
  const button = (text, action, disabled = false) => {
    const result = node('button', text, 'recursion-button'); result.type = 'button'; result.disabled = disabled;
    result.dataset.reviewAction = action;
    result.addEventListener('click', () => act(action)); return result;
  };
  function close() {
    request++;
    unsubscribe?.(); unsubscribe = null;
    const closed = dialog; dialog = null;
    closed?.close?.(); closed?.remove();
    for (const [element, top, left] of scrollPositions) { element.scrollTop = top; element.scrollLeft = left; }
    if (opener?.isConnected !== false) opener?.focus?.({ preventScroll: true });
  }
  function render(message = '') {
    if (!dialog) return;
    const activeAction = document.activeElement?.dataset?.reviewAction;
    const oldBodies = [...dialog.querySelectorAll('[data-review-body]')].map(body => body.scrollTop);
    const record = records.find(entry => entry.id === selectedId);
    const header = node('header', '', 'recursion-review-header');
    header.appendChild(node('h2', record?.state === 'pending' ? 'Review revision' : 'Compare revision'));
    header.appendChild(button('Close', 'close'));
    const body = node('div', '', 'recursion-review-content');
    const footer = node('footer', '', 'recursion-review-actions');
    if (!record) body.appendChild(node('p', message || 'Comparison unavailable. It may have expired or been cleared.'));
    else {
      const choices = node('select'); choices.setAttribute('aria-label', 'Revision'); choices.dataset.reviewAction = 'select'; choices.disabled = busy || editing;
      for (const entry of records) {
        const option = node('option', `${entry.state === 'pending' ? 'Review' : 'Compare'} · ${entry.writer?.label || 'Writer'} · ${entry.editingScope === 'revise' ? 'Revise' : 'Polish'} · ${entry.state}`);
        option.value = entry.id; choices.appendChild(option);
      }
      choices.value = selectedId;
      choices.addEventListener('change', () => { selectedId = choices.value; render(); });
      body.appendChild(choices);
      body.appendChild(node('p', `${record.writer?.label || 'Current SillyTavern model'} · ${record.editingScope === 'revise' ? 'Revise' : 'Polish'} · ${record.state}${record.manualEdit ? ' · Manually edited' : ''}`, 'recursion-post-process-help'));
      const eligible = record.eligible === true && record.state !== 'stale';
      const note = node('p', message || (!eligible ? record.ineligibleReason || 'This source is no longer eligible for changes.' : ''), 'recursion-review-status');
      note.setAttribute('role', 'status'); body.appendChild(note);
      const toggle = button(highlighted ? 'Read clean text' : 'Highlight changes', 'view', editing);
      toggle.setAttribute('aria-pressed', String(highlighted)); body.appendChild(toggle);
      const columns = node('div', '', 'recursion-review-columns');
      const original = String(record.originalSnapshot?.originalDraft ?? '');
      const candidate = String(record.candidateText ?? '');
      const diff = highlighted && !editing ? buildRevisionDiff(original, candidate) : null;
      for (const [side, title, text] of [['original', 'Original', original], ['revised', 'Revision', candidate]]) {
        const section = node('section'); section.appendChild(node('h3', title));
        if (side === 'revised' && editing) {
          const editor = node('textarea'); editor.value = candidate; editor.dataset.reviewEditor = ''; editor.setAttribute('aria-label', 'Edit revision'); editor.className = 'recursion-review-editor'; section.appendChild(editor);
        } else {
          const prose = node('div', '', 'recursion-review-prose'); prose.dataset.reviewBody = side; prose.tabIndex = 0;
          for (const part of diff?.[side] || [{ text }]) prose.appendChild(node(part.changed ? (side === 'original' ? 'del' : 'ins') : 'span', part.text));
          section.appendChild(prose);
        }
        columns.appendChild(section);
      }
      body.appendChild(columns);
      if (diff?.coarse) body.appendChild(node('p', 'Large revision: changes are highlighted in blocks.', 'recursion-post-process-help'));
      body.appendChild(node('p', record.applyMode === 'replace'
        ? 'Use revision replaces the selected response.'
        : 'Use revision adds and selects a new swipe. The original stays available.', 'recursion-post-process-help'));
      const disabled = busy || !eligible;
      footer.appendChild(button('Keep original', 'keep', disabled || editing || record.state === 'rejected'));
      footer.appendChild(button(editing ? 'Save and use revision' : 'Use revision', 'apply', disabled || (record.state === 'applied' && !editing) || record.state === 'rejected'));
      footer.appendChild(button(editing ? 'Cancel edit' : 'Edit revision', editing ? 'cancel-edit' : 'edit', disabled || record.state === 'rejected'));
      footer.appendChild(button('Try another revision', 'retry', disabled || editing));
    }
    dialog.replaceChildren(header, body, footer);
    [...dialog.querySelectorAll('[data-review-body]')].forEach((element, index) => { element.scrollTop = oldBodies[index] || 0; });
    if (editing) dialog.querySelector('[data-review-editor]')?.focus({ preventScroll: true });
    else if (activeAction) [...dialog.querySelectorAll('[data-review-action]')].find(element => element.dataset.reviewAction === activeAction)?.focus({ preventScroll: true });
  }
  async function refresh() {
    if (!dialog || busy || editing) return;
    const version = ++request;
    try {
      const next = await runtime.postProcessComparisons();
      if (!dialog || version !== request || busy || editing) return;
      records = Array.isArray(next) ? next : [];
      render();
    } catch { if (dialog && version === request) render('Could not load comparisons. Reopen to try again.'); }
  }
  async function act(action) {
    if (action === 'close') { close(); return; }
    if (busy) return;
    if (action === 'view') { highlighted = !highlighted; render(); return; }
    if (action === 'edit' || action === 'cancel-edit') { editing = action === 'edit'; render(); return; }
    const record = records.find(entry => entry.id === selectedId);
    if (!record || record.eligible !== true) return;
    let text;
    if (editing && action === 'apply') {
      text = dialog.querySelector('[data-review-editor]')?.value || '';
      if (!text.trim()) { const status = dialog.querySelector('[role="status"]'); if (status) status.textContent = 'Revision must not be empty.'; return; }
    }
    const actionId = selectedId;
    const actionDialog = dialog;
    request++; // Invalidate reads that started before this action.
    busy = true;
    // Disable in place to preserve unsaved text and the user's reading position.
    for (const element of dialog.querySelectorAll('button, select, textarea')) if (element.dataset.reviewAction !== 'close') element.disabled = true;
    try {
      if (text !== undefined) {
        const saved = await runtime.reviewPostProcess({ id: actionId, action: 'edit', text });
        if (dialog !== actionDialog) return;
        if (!saved?.ok) throw new Error(saved?.reason || 'Could not save revision.');
        if (saved.comparison) records = records.map(entry => entry.id === selectedId ? saved.comparison : entry);
        editing = false;
      }
      const result = await runtime.reviewPostProcess({ id: actionId, action });
      if (dialog !== actionDialog) return;
      if (!result?.ok) throw new Error(result?.reason || 'This revision cannot be changed.');
      const next = await runtime.postProcessComparisons();
      if (dialog !== actionDialog) return;
      records = Array.isArray(next) ? next : [];
      if (result.comparison?.id) selectedId = result.comparison.id;
      editing = false; busy = false;
      render(action === 'retry' ? 'Another revision is ready for review.' : action === 'keep' ? 'Original kept.' : 'Revision applied.');
    } catch (error) {
      if (dialog !== actionDialog) return;
      busy = false;
      // Keep manual text after a rejected action so it can be recovered.
      const draft = text;
      render(error.message || 'Could not update revision.');
      if (editing && draft !== undefined && dialog) dialog.querySelector('[data-review-editor]').value = draft;
    }
  }
  async function open({ id, targetIdentity } = {}) {
    if (dialog) close();
    opener = document.activeElement;
    scrollPositions = [];
    for (const element of new Set([document.scrollingElement, document.querySelector('#chat'), opener?.closest?.('.mes')].filter(Boolean))) scrollPositions.push([element, element.scrollTop, element.scrollLeft]);
    dialog = node('dialog', '', 'recursion-review-dialog');
    dialog.setAttribute('aria-label', 'Post-process revision comparison');
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const focusable = [...dialog.querySelectorAll('button, select, textarea, [tabindex="0"]')].filter(element => !element.disabled && !element.hidden);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    document.body.appendChild(dialog);
    records = []; editing = false; busy = false; selectedId = id || '';
    dialog.appendChild(node('p', 'Loading comparison…'));
    dialog.showModal();
    const version = ++request;
    try {
      const next = await runtime.postProcessComparisons();
      if (!dialog || version !== request) return;
      records = Array.isArray(next) ? next : [];
      if (!id && targetIdentity) {
        records = records.filter(entry => Object.entries(targetIdentity).every(([key, value]) => entry.targetIdentity?.[key] === value));
      }
      selectedId ||= records.find(entry => entry.state === 'pending')?.id || records[0]?.id || '';
      render(); dialog.querySelector('button')?.focus({ preventScroll: true });
      if (typeof runtime.subscribe === 'function') unsubscribe = runtime.subscribe(refresh);
    } catch (error) { render('Could not load comparisons.'); onError(error.message); }
  }
  return { open, refresh, destroy: close };
}
