'use strict';
const $ = id => document.getElementById(id);
let nickname = '';
let snapshot = null;
let signature = '';
let fetchGeneration = 0;
let polling = false;
let activeStatus = 'all';
let onlyMine = false;
let importMode = 'merge';
let importing = false;
let pending = new Set();
const collapsed = new Set();
const labels = { todo: 'Not solved', in_progress: 'In progress', done: 'Done' };

function validNickname(value) {
  return typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 20 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function readNickname() {
  const part = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('nickname='));
  try { const value = part ? decodeURIComponent(part.slice(9)).trim() : ''; return validNickname(value) ? value : ''; }
  catch { return ''; }
}
function showNickname() {
  $('nickname-input').value = nickname;
  $('nickname-cancel').hidden = !nickname;
  $('nickname-error').hidden = true;
  $('nickname-dialog').showModal();
  $('nickname-input').focus();
}
$('nickname-dialog').addEventListener('cancel', event => { if (!nickname) event.preventDefault(); });
$('nickname-cancel').addEventListener('click', () => $('nickname-dialog').close());
$('change-nickname').addEventListener('click', event => { event.preventDefault(); showNickname(); });
$('nickname-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = $('nickname-input').value.trim();
  if (!validNickname(value)) {
    $('nickname-error').textContent = 'Use 2–20 characters, without control characters.';
    $('nickname-error').hidden = false;
    return;
  }
  nickname = value;
  document.cookie = 'nickname=' + encodeURIComponent(value) + '; Max-Age=31536000; Expires=' + new Date(Date.now() + 31536000000).toUTCString() + '; Path=/; SameSite=Lax';
  $('identity').textContent = nickname;
  $('nickname-dialog').close();
  render();
});

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = 'notice' + (error ? ' error' : '');
  $('notice').hidden = false;
}
async function api(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(path, { cache: 'no-store', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Server timed out. Check your connection and retry.');
    throw error;
  } finally { clearTimeout(timer); }
}
async function refresh() {
  if (polling) return;
  polling = true;
  const generation = ++fetchGeneration;
  try {
    const data = await api('/api/tasks');
    if (generation !== fetchGeneration) return;
    if (!data || !Array.isArray(data.tasks)) throw new Error('Invalid server response.');
    $('connection').className = 'connection';
    $('connection-label').textContent = 'connected';
    $('connection').title = '';
    const synced = new Date();
    $('last-sync').textContent = synced.toLocaleTimeString();
    $('last-sync').dateTime = synced.toISOString();
    const next = JSON.stringify(data);
    if (next !== signature) { snapshot = data; signature = next; render(); }
  } catch (error) {
    if (generation !== fetchGeneration) return;
    $('connection').className = 'connection lost';
    $('connection-label').textContent = 'unreachable · retrying';
    $('connection').title = error.message;
    if (!snapshot) $('results').textContent = 'Waiting for the server…';
  } finally { polling = false; }
}

// Every imported or user-supplied string goes through textContent, never innerHTML.
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function isMine(task) { return task.status === 'in_progress' && task.owner === nickname; }
const shortStatus = { todo: 'TODO', in_progress: 'WIP', done: 'DONE' };
const statusClass = { todo: 'todo', in_progress: 'wip', done: 'done' };

function taskRow(task) {
  const mine = isMine(task);
  const row = element('div', 'task-row' + (mine ? ' is-mine' : ''));
  row.dataset.status = statusClass[task.status];
  const state = element('span', 'state-label', shortStatus[task.status]);
  state.title = labels[task.status];
  const title = element('span', 'task-title', task.title);
  title.title = task.title + ' · ' + task.category;
  const owner = element('span', 'owner', task.owner || '—');
  owner.title = task.owner ? (task.status === 'done' ? 'Solved by ' : 'Taken by ') + task.owner : 'Unassigned';
  if (mine) owner.append(element('span', 'you-tag', 'YOU'));
  const actions = element('span', 'actions');
  const buttons = task.status === 'todo' ? [['Take', 'in_progress']] :
    task.status === 'in_progress' ? [['Done', 'done'], ['Release', 'todo']] : [['Reopen', 'todo']];
  for (const [label, nextStatus] of buttons) {
    const button = element('button', 'action' + (nextStatus === 'done' ? ' primary' : ''), label);
    button.type = 'button';
    button.dataset.task = task.id;
    button.dataset.action = nextStatus;
    button.disabled = pending.has(task.id);
    button.setAttribute('aria-label', label + ' — ' + task.title);
    button.addEventListener('click', () => updateTask(task.id, nextStatus));
    actions.append(button);
  }
  row.title = 'Updated ' + new Date(task.updatedAt).toLocaleString();
  row.append(state, title, owner, actions);
  return row;
}

function taskSection(title, tasks, total, key, mine = false) {
  const details = element('details', 'section' + (mine ? ' mine' : ''));
  details.open = !collapsed.has(key);
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    if (details.open) collapsed.delete(key); else collapsed.add(key);
  });
  const summary = element('summary');
  const progress = element('span', 'section-progress');
  progress.setAttribute('aria-hidden', 'true');
  progress.style.setProperty('--progress', (total.total ? total.done / total.total * 100 : 0) + '%');
  progress.append(element('span'));
  summary.append(element('span', 'section-title', title),
    element('span', 'section-meta', total.done + '/' + total.total), progress);
  const rows = element('div', 'rows');
  for (const task of tasks.slice().sort((a, b) => a.title.localeCompare(b.title))) rows.append(taskRow(task));
  details.append(summary, rows);
  return details;
}

function render() {
  if (!snapshot) return;
  const scrollX = window.scrollX, scrollY = window.scrollY;
  const focused = document.activeElement;
  const focusTask = focused && focused.dataset.task;
  const focusAction = focused && focused.dataset.action;
  const counts = { todo: 0, in_progress: 0, done: 0 };
  for (const task of snapshot.tasks) counts[task.status]++;
  $('total').textContent = snapshot.tasks.length;
  $('done-total').textContent = counts.done;
  $('todo-count').textContent = counts.todo;
  $('in-progress-count').textContent = counts.in_progress;
  const mineCount = snapshot.tasks.filter(isMine).length;
  $('only-mine').title = mineCount + ' in-progress tasks assigned to you';
  const segments = document.createDocumentFragment();
  // Keep the header compact even for very large imports.
  if (snapshot.tasks.length <= 160) {
    for (const task of snapshot.tasks) {
      const segment = element('span', 'segment ' + statusClass[task.status]);
      segment.title = task.title + ': ' + labels[task.status];
      segments.append(segment);
    }
  } else {
    for (const status of ['done', 'in_progress', 'todo']) {
      if (!counts[status]) continue;
      const segment = element('span', 'segment ' + statusClass[status]);
      segment.style.flex = counts[status];
      segment.title = counts[status] + ' ' + labels[status];
      segments.append(segment);
    }
  }
  $('segments').replaceChildren(segments);
  $('last-updated').textContent = new Date(snapshot.updatedAt).toLocaleTimeString();
  $('last-updated').title = new Date(snapshot.updatedAt).toLocaleString();
  $('last-updated').dateTime = snapshot.updatedAt;
  const query = $('search').value.trim().toLocaleLowerCase();
  const groups = new Map();
  const totals = new Map();
  const myTasks = [];
  let visible = 0;
  for (const task of snapshot.tasks) {
    const total = totals.get(task.category) || { done: 0, total: 0 };
    total.total++; if (task.status === 'done') total.done++;
    totals.set(task.category, total);
    if (!task.title.toLocaleLowerCase().includes(query) || (activeStatus !== 'all' && task.status !== activeStatus) || (onlyMine && !isMine(task))) continue;
    if (isMine(task)) myTasks.push(task);
    else {
      if (!groups.has(task.category)) groups.set(task.category, []);
      groups.get(task.category).push(task);
    }
    visible++;
  }
  $('results').textContent = visible + '/' + snapshot.tasks.length + ' tasks' + (onlyMine ? ' · only mine' : '');
  const fragment = document.createDocumentFragment();
  if (myTasks.length) fragment.append(taskSection('my tasks', myTasks, { done: 0, total: mineCount }, 'mine', true));
  for (const [category, tasks] of [...groups].sort((a,b) => a[0].localeCompare(b[0]))) {
    fragment.append(taskSection(category, tasks, totals.get(category), 'category:' + category));
  }
  if (!visible) {
    const empty = element('div', 'empty');
    empty.append(element('strong', '', snapshot.tasks.length ? '[no matching tasks]' : '[no tasks yet]'));
    empty.append(element('p', '', snapshot.tasks.length ? 'try a different search or filter' : 'import an XML file or drop it here to get started'));
    fragment.append(empty);
  }
  $('tasks').replaceChildren(fragment);
  if (focusTask) {
    const replacement = [...$('tasks').querySelectorAll('button')].find(button => button.dataset.task === focusTask && button.dataset.action === focusAction);
    if (replacement) replacement.focus({ preventScroll: true });
  }
  window.scrollTo(scrollX, scrollY);
}
async function updateTask(id, status) {
  if (!nickname) { showNickname(); return; }
  if (pending.has(id)) return;
  pending.add(id); render();
  ++fetchGeneration; // Discard a poll that started before this mutation.
  try {
    await api('/api/tasks/' + id, { status, nickname });
    await refresh();
  } catch (error) { notice('Task update failed: ' + error.message, true); }
  finally { pending.delete(id); render(); }
}
$('search').addEventListener('input', render);
for (const button of document.querySelectorAll('[data-status-filter]')) {
  button.addEventListener('click', () => {
    activeStatus = button.dataset.statusFilter;
    for (const filter of document.querySelectorAll('[data-status-filter]')) {
      filter.setAttribute('aria-pressed', String(filter === button));
    }
    render();
  });
}
$('only-mine').addEventListener('click', () => {
  onlyMine = !onlyMine;
  $('only-mine').setAttribute('aria-pressed', String(onlyMine));
  render();
});
window.addEventListener('keydown', event => {
  const editing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable;
  if (event.key === '/' && !editing && !$('nickname-dialog').open && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    $('search').focus();
  }
});

function xmlTasks(source) {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  const all = [...doc.getElementsByTagName('*')];
  if (!doc.documentElement || all.some(node => node.localName.toLowerCase() === 'parsererror')) {
    throw new Error('Invalid XML. Check that tags are correctly closed and special characters are escaped.');
  }
  const name = node => node.localName.toLowerCase();
  const nodes = all.filter(node => name(node) === 'task');
  if (!nodes.length) throw new Error('No <task> elements found in the XML.');
  function field(node, key) {
    const attr = [...node.attributes].find(attr => attr.localName.toLowerCase() === key && attr.value.trim());
    if (attr) return attr.value.trim();
    const child = [...node.children].find(child => name(child) === key && child.textContent.trim());
    return child ? child.textContent.trim() : '';
  }
  return nodes.map((node, index) => {
    const title = field(node, 'title'), category = field(node, 'category');
    if (!title || !category) throw new Error('Task ' + (index + 1) + ' is missing a title or category. Nothing was imported.');
    return { title, category };
  });
}
async function importFile(file, mode) {
  if (importing) return;
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { notice('XML file is too large (maximum 10 MiB).', true); return; }
  importing = true;
  $('import').disabled = $('replace').disabled = true;
  try {
    const tasks = xmlTasks(await file.text());
    if (mode === 'replace' && !confirm('Replace ALL tasks with ' + tasks.length + ' imported tasks? All current statuses and owners will be reset.')) return;
    ++fetchGeneration;
    const result = await api('/api/import', { tasks, mode });
    notice(result.added + ' added, ' + result.existed + ' already existed' + (mode === 'replace' ? ' · Replaced all tasks.' : ''));
    await refresh();
  } catch (error) { notice('Import failed: ' + error.message, true); }
  finally { importing = false; $('import').disabled = $('replace').disabled = false; $('xml-file').value = ''; }
}
$('import').addEventListener('click', () => { importMode = 'merge'; $('xml-file').value = ''; $('xml-file').click(); });
$('replace').addEventListener('click', () => { importMode = 'replace'; $('xml-file').value = ''; $('xml-file').click(); });
$('xml-file').addEventListener('change', event => importFile(event.target.files[0], importMode));
let dragDepth = 0;
window.addEventListener('dragenter', event => {
  if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; }
});
window.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').hidden = true; });
window.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true;
  if (event.dataTransfer.files.length !== 1) { notice('Drop one XML file at a time.', true); return; }
  importFile(event.dataTransfer.files[0], 'merge');
});
nickname = readNickname();
$('identity').textContent = nickname || 'Choose a nickname';
if (!nickname) showNickname();
refresh();
setInterval(refresh, 3000);
window.addEventListener('online', refresh);
