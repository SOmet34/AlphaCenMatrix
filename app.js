(() => {
  'use strict';

  const STORAGE_KEY = 'best-robot-test-tracker.v1';
  const BACKUP_KEY = STORAGE_KEY + '.unreadable';
  const UNAVAILABLE_MESSAGE = 'Storage is unavailable. Runs are kept only in memory for this tab — use Export CSV before closing it.';
  const OUTCOMES = { success: 'Success', miss: 'Miss' };
  const OUTCOME_MARKS = { success: '✓', miss: '✗' };
  const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const DATE_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  function nextLocalMidnight() {
    const next = new Date();
    next.setHours(24, 0, 0, 0);
    return next.getTime();
  }

  let timeLabelCacheDayEnd = nextLocalMidnight();
  const deletedRunIds = new Set();
  const historyRows = new Map(); // run id -> rendered row, for O(1) note/undo updates
  const timeLabelCache = new Map(); // minute -> formatted label, for full history renders

  const data = { tests: [], activeTestId: null };
  let view = 'setup';
  let storageOk = true;
  let lastEvent = null;
  let lastSavedRaw = null; // payload this tab last loaded or wrote
  let lastMergeChanged = false; // did save() absorb runs from another tab?
  const el = {};

  const byId = (id) => document.getElementById(id);
  const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function getActiveTest() {
    return data.tests.find((test) => test.id === data.activeTestId) || null;
  }

  /* ---------- Persistence ---------- */

  function normalizeTest(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
    if (!Array.isArray(raw.designs) || raw.designs.length !== 2) return null;

    const designs = raw.designs.map((design) =>
      typeof design === 'string' && design.trim() ? design.trim().slice(0, 40) : null
    );
    if (!designs[0] || !designs[1]) return null;

    const runs = Array.isArray(raw.runs)
      ? raw.runs.filter((run) =>
          run &&
          (run.design === 0 || run.design === 1) &&
          (run.outcome === 'success' || run.outcome === 'miss') &&
          Number.isFinite(run.ts)
        ).map((run) => ({
          id: typeof run.id === 'string' && run.id ? run.id : uid(),
          design: run.design,
          outcome: run.outcome,
          ts: run.ts,
          note: typeof run.note === 'string' ? run.note.slice(0, 300) : ''
        }))
      : [];

    return {
      id: raw.id,
      name: raw.name.trim().slice(0, 90),
      designs,
      selectedDesign: raw.selectedDesign === 1 ? 1 : 0,
      runs,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
    };
  }

  function showStorageWarning(message) {
    storageOk = false;
    el.storageBanner.textContent = message || UNAVAILABLE_MESSAGE;
    el.storageBanner.hidden = false;
  }

  function backupUnreadable(raw) {
    try {
      localStorage.setItem(BACKUP_KEY, raw);
      return true;
    } catch (err) {
      return false;
    }
  }

  function showDataWarning(problem, raw) {
    const backedUp = raw !== null && backupUnreadable(raw);
    const backupText = backedUp
      ? 'The unreadable data was kept as a backup in this browser.'
      : 'The unreadable data could not be backed up.';
    el.storageBanner.textContent = problem === 'partial'
      ? 'Some saved tests could not be read. ' + backupText
      : 'Saved tests could not be read. ' + backupText + ' The app started with an empty list.';
    el.storageBanner.hidden = false;
  }

  function parseSaved(raw) {
    if (raw === null || raw === undefined) {
      return { tests: [], activeTestId: null, problem: null };
    }

    let saved;
    try {
      saved = JSON.parse(raw);
    } catch (err) {
      return { tests: [], activeTestId: null, problem: 'parse' };
    }

    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.tests)) {
      return { tests: [], activeTestId: null, problem: 'shape' };
    }

    const normalized = saved.tests.map(normalizeTest);
    const tests = normalized.filter(Boolean);
    const wanted = typeof saved.activeTestId === 'string' ? saved.activeTestId : null;
    return {
      tests,
      activeTestId: tests.some((test) => test.id === wanted)
        ? wanted
        : (tests[0] ? tests[0].id : null),
      problem: tests.length === saved.tests.length ? null : 'partial'
    };
  }

  function applySaved(raw, warnAboutProblems) {
    const result = parseSaved(raw);
    data.tests = result.tests;
    data.activeTestId = result.activeTestId;
    if (result.problem && warnAboutProblems) showDataWarning(result.problem, raw);
    return result;
  }

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      showStorageWarning();
      view = 'setup';
      return;
    }

    if (raw !== null) applySaved(raw, true);
    lastSavedRaw = raw;
    view = data.tests.length && getActiveTest() ? 'log' : 'setup';
  }

  function mergeStoredChanges(raw) {
    let changed = false;
    let saved;
    try {
      saved = JSON.parse(raw);
    } catch (err) {
      return false;
    }
    if (!saved || !Array.isArray(saved.tests)) return false;

    const localById = new Map(data.tests.map((test) => [test.id, test]));
    saved.tests.map(normalizeTest).filter(Boolean).forEach((storedTest) => {
      const localTest = localById.get(storedTest.id);
      if (!localTest) {
        data.tests.push(storedTest);
        localById.set(storedTest.id, storedTest);
        changed = true;
        return;
      }

      const localRuns = new Map(localTest.runs.map((run) => [run.id, run]));
      let testChanged = false;
      storedTest.runs.forEach((storedRun) => {
        if (deletedRunIds.has(storedRun.id)) return;
        const localRun = localRuns.get(storedRun.id);
        if (!localRun) {
          localTest.runs.push(storedRun);
          localRuns.set(storedRun.id, storedRun);
          testChanged = true;
        } else if (!localRun.note && storedRun.note) {
          localRun.note = storedRun.note;
          testChanged = true;
        }
      });
      if (testChanged) {
        localTest.runs.sort((a, b) => a.ts - b.ts);
        changed = true;
      }
    });

    data.tests.sort((a, b) => b.createdAt - a.createdAt);
    return changed;
  }

  function save() {
    try {
      lastMergeChanged = false;
      // Only reparse the payload when another tab has written since our last save.
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null && raw !== lastSavedRaw) {
        lastMergeChanged = mergeStoredChanges(raw);
      }
      const serialized = JSON.stringify({
        tests: data.tests,
        activeTestId: data.activeTestId
      });
      localStorage.setItem(STORAGE_KEY, serialized);
      lastSavedRaw = serialized;
      storageOk = true;
      el.storageBanner.hidden = true;
      return true;
    } catch (err) {
      showStorageWarning();
      return false;
    }
  }

  function syncFromStorage(raw) {
    lastSavedRaw = raw;
    if (raw === null) {
      data.tests = [];
      data.activeTestId = null;
      view = 'setup';
      lastEvent = null;
      if (storageOk) el.storageBanner.hidden = true;
      render();
      return;
    }

    const active = document.activeElement;
    const focusId = active && active.id;
    const wasDesignRadio = Boolean(active && active.classList && active.classList.contains('design-radio'));
    const result = applySaved(raw, true);
    if (!result.problem && storageOk) el.storageBanner.hidden = true;
    if (view === 'log' && !getActiveTest()) view = 'setup';
    lastEvent = null;
    render();

    if (wasDesignRadio) {
      const checked = el.designSwitch.querySelector('input:checked');
      if (checked) checked.focus();
    } else if (focusId === 'undo-btn') {
      el.successBtn.focus();
    } else if (focusId) {
      const node = byId(focusId);
      if (node && !node.hidden) node.focus();
    }
  }

  /* ---------- Formatting ---------- */

  function formatDate(ts) {
    const date = new Date(ts);
    const now = new Date();
    return (date.getFullYear() === now.getFullYear() ? DATE_FORMAT : DATE_YEAR_FORMAT).format(date);
  }

  function formatTime(ts) {
    // A full history often has many runs in the same displayed minute.
    // Clear once when the day changes so "today" labels do not go stale.
    if (Date.now() >= timeLabelCacheDayEnd) {
      timeLabelCache.clear();
      timeLabelCacheDayEnd = nextLocalMidnight();
    }

    const minute = Math.floor(ts / 60000);
    const cached = timeLabelCache.get(minute);
    if (cached !== undefined) return cached;

    const date = new Date(ts);
    const now = new Date();
    const time = TIME_FORMAT.format(date);
    const label = date.toDateString() === now.toDateString()
      ? time
      : formatDate(ts) + ', ' + time;

    if (timeLabelCache.size >= 200) timeLabelCache.clear();
    timeLabelCache.set(minute, label);
    return label;
  }

  function isoLocal(ts) {
    const date = new Date(ts);
    const pad = (value) => String(value).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const abs = Math.abs(offset);
    return (
      date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
      sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
    );
  }

  function csvCell(value) {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function buildCsv(test) {
    const rows = [['Test', 'Design', 'Timestamp', 'Outcome', 'Note']];
    test.runs.forEach((run) => {
      rows.push([
        test.name,
        test.designs[run.design],
        isoLocal(run.ts),
        OUTCOMES[run.outcome],
        run.note || ''
      ]);
    });
    return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  function safeSlug(value) {
    return value.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'robot-test';
  }

  function csvFileName(test) {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    return safeSlug(test.name) + '-' + stamp + '.csv';
  }

  /* ---------- Rendering: setup ---------- */

  function renderSetup() {
    document.title = 'BEST Robotics test log';
    el.backToLog.hidden = !getActiveTest();

    const hasTests = data.tests.length > 0;
    el.savedTestsSection.hidden = !hasTests;

    if (!hasTests) {
      el.testList.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();
    data.tests.forEach((test) => {
      const item = h('li');
      const button = h('button', 'saved-test');
      button.type = 'button';
      button.setAttribute(
        'aria-label',
        test.name + '. ' + test.designs[0] + ' versus ' + test.designs[1] + '. '
          + test.runs.length + (test.runs.length === 1 ? ' run' : ' runs') + '. Created '
          + formatDate(test.createdAt) + '. Open test.'
      );
      button.append(
        h('span', 'saved-name', test.name),
        h(
          'span',
          'saved-meta',
          test.designs[0] + ' · ' + test.designs[1] +
            ' · ' + test.runs.length + (test.runs.length === 1 ? ' run' : ' runs') +
            ' · ' + formatDate(test.createdAt)
        ),
        h('span', 'saved-open', 'Open')
      );
      button.addEventListener('click', () => openTest(test.id));
      item.append(button);
      fragment.append(item);
    });
    el.testList.replaceChildren(fragment);
  }

  /* ---------- Rendering: practice screen ---------- */

  function renderLog(test) {
    document.title = test.name + ' · BEST Robotics test log';
    el.taskTitle.textContent = test.name;
    renderDesignOptions(test);
    refreshLog(test);
    renderFeedback(test);
  }

  function renderDesignOptions(test) {
    el.designSwitch.innerHTML = '';

    test.designs.forEach((name, index) => {
      const option = h('label', 'design-option' + (index === test.selectedDesign ? ' is-selected' : ''));
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'design-choice';
      input.value = String(index);
      input.className = 'design-radio';
      input.checked = index === test.selectedDesign;
      input.addEventListener('change', () => {
        if (input.checked) selectDesign(index);
      });

      const mark = h('span', 'design-mark');
      mark.setAttribute('aria-hidden', 'true');

      option.append(input, mark, h('span', 'design-name', name));
      el.designSwitch.append(option);
    });
  }

  function applyDesignSelection(test) {
    const options = el.designSwitch.querySelectorAll('.design-option');
    options.forEach((option, index) => {
      const selected = index === test.selectedDesign;
      option.classList.toggle('is-selected', selected);
      const input = option.querySelector('.design-radio');
      if (input) input.checked = selected;
    });
  }

  function updateActionLabels(test) {
    const name = test.designs[test.selectedDesign];
    el.successBtn.setAttribute('aria-label', 'Record a success for ' + name);
    el.missBtn.setAttribute('aria-label', 'Record a miss for ' + name);
  }

  function renderResults(test) {
    const stats = test.designs.map(() => ({ attempts: 0, successes: 0 }));
    test.runs.forEach((run) => {
      const bucket = stats[run.design];
      if (!bucket) return;
      bucket.attempts += 1;
      if (run.outcome === 'success') bucket.successes += 1;
    });

    const fragment = document.createDocumentFragment();
    test.designs.forEach((name, index) => {
      const { attempts, successes } = stats[index];
      const row = document.createElement('tr');

      const designCell = document.createElement('th');
      designCell.setAttribute('scope', 'row');
      const cell = h('span', 'design-cell');
      cell.append(h('span', 'design-cell-name', name));
      if (index === test.selectedDesign) {
        cell.append(h('span', 'logging-tag', '✓ Logging'));
      }
      designCell.append(cell);

      const recordCell = h('td', 'record-cell');
      recordCell.setAttribute('data-label', 'Record');
      row.dataset.successes = String(successes);
      row.dataset.attempts = String(attempts);

      if (attempts === 0) {
        recordCell.append(h('span', 'record-empty', 'No runs yet'));
        recordCell.setAttribute('aria-label', 'No runs yet');
        row.dataset.rate = '';
      } else {
        const percent = Math.round((successes / attempts) * 100);
        recordCell.append(
          h('span', 'record-fraction', successes + '/' + attempts),
          h('span', 'record-sep', ' · '),
          h('span', 'record-rate', percent + '%')
        );
        recordCell.setAttribute(
          'aria-label',
          successes + (successes === 1 ? ' success in ' : ' successes in ')
            + attempts + (attempts === 1 ? ' attempt, ' : ' attempts, ') + percent + ' percent'
        );
        row.dataset.rate = percent + '%';
      }

      row.append(designCell, recordCell);
      fragment.append(row);
    });
    el.resultsBody.replaceChildren(fragment);
  }

  function createHistoryRow(test, run) {
    const row = h('li', 'run-row');
    row.dataset.runId = run.id;
    const main = h('div', 'run-main');
    main.append(
      h('span', 'run-outcome ' + run.outcome, OUTCOME_MARKS[run.outcome] + ' ' + OUTCOMES[run.outcome]),
      h('span', 'run-design', test.designs[run.design])
    );

    const time = document.createElement('time');
    time.className = 'run-time';
    time.dateTime = new Date(run.ts).toISOString();
    time.textContent = formatTime(run.ts);

    row.append(main, time);
    if (run.note) row.append(h('p', 'run-note', run.note));
    return row;
  }

  function renderHistory(test) {
    // Build off-DOM so a full history costs one insertion, not one per row.
    historyRows.clear();
    const fragment = document.createDocumentFragment();

    if (!test.runs.length) {
      fragment.append(h('li', 'empty-log', 'No runs recorded yet.'));
      el.history.replaceChildren(fragment);
      return;
    }

    for (let index = test.runs.length - 1; index >= 0; index -= 1) {
      const run = test.runs[index];
      const row = createHistoryRow(test, run);
      historyRows.set(run.id, row);
      fragment.append(row);
    }
    el.history.replaceChildren(fragment);
  }

  function prependHistoryRow(test, run) {
    el.history.querySelector('.empty-log')?.remove();
    const row = createHistoryRow(test, run);
    row.classList.add('is-new');
    el.history.prepend(row);
    historyRows.set(run.id, row);
  }

  function removeHistoryRow(test, runId) {
    const row = historyRows.get(runId);
    if (row) row.remove();
    historyRows.delete(runId);
    if (!test.runs.length) renderHistory(test);
  }

  function updateHistoryNote(run) {
    const row = historyRows.get(run.id);
    if (!row) return;
    let note = row.querySelector('.run-note');
    if (!run.note) {
      if (note) note.remove();
      return;
    }
    if (!note) {
      note = h('p', 'run-note');
      row.append(note);
    }
    note.textContent = run.note;
  }

  function updateRunTotal(test) {
    const count = test.runs.length;
    el.runTotal.textContent = count + (count === 1 ? ' run' : ' runs');
  }

  function updateNoteState(test) {
    const last = test.runs.length ? test.runs[test.runs.length - 1] : null;
    el.noteInput.disabled = !last;
    el.noteSave.disabled = !last;
    el.noteCancel.disabled = !last;
    el.noteInput.placeholder = last ? 'Note for the last run' : 'Log a run first';
    el.noteTarget.textContent = last
      ? 'Note for last run: ' + test.designs[last.design] + ' · ' + OUTCOMES[last.outcome] + ' · ' + formatTime(last.ts)
      : 'No run to annotate yet.';
  }

  function refreshLog(test) {
    updateActionLabels(test);
    renderResults(test);
    renderHistory(test);
    updateNoteState(test);
    updateRunTotal(test);
  }

  function setFeedback(lead, result, undo) {
    el.feedbackLead.textContent = lead ? lead + ' · ' : '';
    el.feedbackResult.textContent = result;
    el.undoBtn.hidden = !undo;
    if (!undo) {
      el.undoBtn.removeAttribute('aria-label');
      el.undoBtn.removeAttribute('title');
    }
  }

  function setUndoAction(test, run) {
    const label = 'Undo ' + OUTCOMES[run.outcome] + ' for ' + test.designs[run.design];
    el.undoBtn.hidden = false;
    el.undoBtn.setAttribute('aria-label', label);
    el.undoBtn.title = label;
  }

  function renderFeedback(test) {
    if (lastEvent && lastEvent.testId === test.id) {
      const run = test.runs.find((item) => item.id === lastEvent.runId);
      if (run) {
        setFeedback('', OUTCOMES[run.outcome] + ' recorded for ' + test.designs[run.design], true);
        setUndoAction(test, run);
        return;
      }
    }

    if (test.runs.length) {
      const last = test.runs[test.runs.length - 1];
      setFeedback(
        'Last run',
        OUTCOMES[last.outcome] + ' for ' + test.designs[last.design] + ' · ' + formatTime(last.ts),
        false
      );
    } else {
      setFeedback('', 'No runs recorded yet', false);
    }
  }

  function render() {
    const test = getActiveTest();
    if (view === 'log' && test) {
      el.setupView.hidden = true;
      el.logView.hidden = false;
      renderLog(test);
    } else {
      view = 'setup';
      el.logView.hidden = true;
      el.setupView.hidden = false;
      renderSetup();
    }
  }

  /* ---------- Actions ---------- */

  function openTest(id) {
    if (!data.tests.some((test) => test.id === id)) return;
    data.activeTestId = id;
    view = 'log';
    lastEvent = null;
    setNoteStatus('');
    save();
    render();
    el.taskTitle.focus();
  }

  function goSetup() {
    view = 'setup';
    render();
    el.setupTitle.focus();
  }

  function backToLog() {
    const test = getActiveTest();
    if (!test) return;
    view = 'log';
    render();
    el.taskTitle.focus();
  }

  function selectDesign(index) {
    const test = getActiveTest();
    if (!test || test.selectedDesign === index) return;
    test.selectedDesign = index;
    save();
    applyDesignSelection(test);
    if (lastMergeChanged) {
      refreshLog(test);
    } else {
      updateActionLabels(test);
      renderResults(test);
    }
  }

  function record(outcome) {
    const test = getActiveTest();
    if (!test) return;

    const run = {
      id: uid(),
      design: test.selectedDesign,
      outcome,
      ts: Date.now(),
      note: ''
    };
    test.runs.push(run);
    lastEvent = { testId: test.id, runId: run.id };
    const persisted = save();
    setNoteStatus('');
    renderResults(test);
    if (lastMergeChanged) {
      renderHistory(test);
    } else {
      prependHistoryRow(test, run);
    }
    updateNoteState(test);
    updateRunTotal(test);
    setFeedback(
      '',
      OUTCOMES[outcome] + ' recorded for ' + test.designs[run.design]
        + (persisted ? '' : ' — this session only'),
      true
    );
    setUndoAction(test, run);
  }

  function focusLoggingAction() {
    if (view === 'log' && getActiveTest()) el.successBtn.focus();
  }

  function undoLast() {
    if (!lastEvent) return;

    const test = data.tests.find((item) => item.id === lastEvent.testId);
    if (!test) {
      lastEvent = null;
      setFeedback('', 'Nothing to undo', false);
      focusLoggingAction();
      return;
    }

    const index = test.runs.findIndex((run) => run.id === lastEvent.runId);
    if (index === -1) {
      lastEvent = null;
      setFeedback('', 'That run is already gone', false);
      focusLoggingAction();
      return;
    }

    const removed = test.runs.splice(index, 1)[0];
    deletedRunIds.add(removed.id);
    lastEvent = null;
    setNoteStatus('');
    const persisted = save();

    if (test.id === data.activeTestId) {
      renderResults(test);
      if (lastMergeChanged) {
        renderHistory(test);
      } else {
        removeHistoryRow(test, removed.id);
      }
      updateNoteState(test);
      updateRunTotal(test);
      setFeedback(
        '',
        OUTCOMES[removed.outcome] + ' removed for ' + test.designs[removed.design]
          + (persisted ? '' : ' — this session only'),
        false
      );
    }
    focusLoggingAction();
  }

  function setNoteStatus(message) {
    el.noteStatus.textContent = message;
  }

  function cancelNote() {
    const test = getActiveTest();
    if (!test || !test.runs.length) return;
    el.noteInput.value = '';
    setNoteStatus('Note edit canceled. The saved note, if any, is unchanged.');
    el.noteInput.focus();
  }

  function saveNote(event) {
    event.preventDefault();
    const test = getActiveTest();
    if (!test || !test.runs.length) {
      setNoteStatus('Log a run before adding a note.');
      return;
    }

    const run = test.runs[test.runs.length - 1];
    const value = el.noteInput.value.trim();

    if (!value) {
      if (!run.note) {
        setNoteStatus('Type a note first.');
        el.noteInput.focus();
        return;
      }
      run.note = '';
      const persisted = save();
      el.noteInput.value = '';
      if (lastMergeChanged) {
        renderHistory(test);
      } else {
        updateHistoryNote(run);
      }
      setNoteStatus(persisted
        ? 'Note removed from the last run.'
        : 'Note removed for this session only — storage is unavailable.');
      return;
    }

    run.note = value;
    const persisted = save();
    el.noteInput.value = '';
    if (lastMergeChanged) {
      renderHistory(test);
    } else {
      updateHistoryNote(run);
    }
    setNoteStatus(persisted
      ? 'Note saved to ' + test.designs[run.design] + ' · ' + OUTCOMES[run.outcome] + '.'
      : 'Note added for this session only — storage is unavailable.');
  }

  function downloadCsv() {
    const test = getActiveTest();
    if (!test) return;

    const blob = new Blob(['\uFEFF' + buildCsv(test)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = csvFileName(test);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ---------- Setup form ---------- */

  function setFieldError(input, error, message) {
    error.textContent = message;
    error.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  }

  function clearFieldError(input, error) {
    error.textContent = '';
    error.hidden = true;
    input.removeAttribute('aria-invalid');
  }

  function clearFormErrors() {
    clearFieldError(el.taskName, el.taskNameError);
    clearFieldError(el.designA, el.designAError);
    clearFieldError(el.designB, el.designBError);
  }

  function onCreateTest(event) {
    event.preventDefault();
    clearFormErrors();

    const name = el.taskName.value.trim();
    const designA = el.designA.value.trim();
    const designB = el.designB.value.trim();
    let invalid = null;

    if (!name) {
      setFieldError(el.taskName, el.taskNameError, 'Enter a task name.');
      invalid = el.taskName;
    }
    if (!designA) {
      setFieldError(el.designA, el.designAError, 'Name Design A.');
      invalid = invalid || el.designA;
    }
    if (!designB) {
      setFieldError(el.designB, el.designBError, 'Name Design B.');
      invalid = invalid || el.designB;
    }
    if (designA && designB && designA.toLowerCase() === designB.toLowerCase()) {
      setFieldError(el.designB, el.designBError, 'Use a different name from Design A.');
      invalid = invalid || el.designB;
    }
    if (invalid) {
      invalid.focus();
      return;
    }

    const test = {
      id: uid(),
      name,
      designs: [designA, designB],
      selectedDesign: 0,
      runs: [],
      createdAt: Date.now()
    };
    data.tests.unshift(test);
    data.activeTestId = test.id;
    view = 'log';
    lastEvent = null;
    setNoteStatus('');
    save();
    el.testForm.reset();
    clearFormErrors();
    render();
    el.taskTitle.focus();
  }

  /* ---------- Wiring ---------- */

  function init() {
    [
      'storage-banner', 'setup-view', 'setup-title', 'back-to-log', 'test-form',
      'task-name', 'design-a', 'design-b', 'task-name-error', 'design-a-error',
      'design-b-error', 'saved-tests-section', 'test-list', 'log-view', 'task-title',
      'design-switch', 'success-btn', 'miss-btn', 'feedback', 'feedback-lead',
      'feedback-result', 'undo-btn',
      'switch-test', 'export-btn', 'results-body', 'note-form', 'note-input',
      'note-save', 'note-cancel', 'note-target', 'note-status', 'run-total', 'history'
    ].forEach((id) => {
      el[id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = byId(id);
    });

    el.testForm.addEventListener('submit', onCreateTest);
    el.successBtn.addEventListener('click', () => record('success'));
    el.missBtn.addEventListener('click', () => record('miss'));
    el.undoBtn.addEventListener('click', undoLast);
    el.noteForm.addEventListener('submit', saveNote);
    el.noteCancel.addEventListener('click', cancelNote);
    el.switchTest.addEventListener('click', goSetup);
    el.backToLog.addEventListener('click', backToLog);
    el.exportBtn.addEventListener('click', downloadCsv);
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      syncFromStorage(event.key === null ? null : event.newValue);
    });

    [
      [el.taskName, el.taskNameError],
      [el.designA, el.designAError],
      [el.designB, el.designBError]
    ].forEach(([input, error]) => {
      input.addEventListener('input', () => clearFieldError(input, error));
    });

    load();
    render();
  }

  init();
})();
