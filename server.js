'use strict';

// No dependencies: run with `node server.js` (Node.js 18+).
const http = require('node:http');
const fs = require('node:fs');
const DATA_FILE = __dirname + '/data.json';
// Serve only these frontend files; storage and backend source stay private.
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const MAX_TASKS = 20000;
const MAX_BODY = 10 * 1024 * 1024;
const STATUSES = new Set(['todo', 'in_progress', 'done']);
let state;
let writeQueue = Promise.resolve();

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function cleanText(value, name, min, max) {
  if (typeof value !== 'string') fail(name + ' must be text.');
  const text = value.trim();
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) {
    fail(name + ' must be ' + min + '–' + max + ' characters, without control characters.');
  }
  return text;
}

// FNV-1a 128-bit over UTF-8, with an unambiguous category/title tuple.
// IDs depend only on the trimmed category and title (case sensitive).
function taskId(category, title) {
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  for (const byte of Buffer.from(JSON.stringify([category, title]), 'utf8')) {
    hash = BigInt.asUintN(128, (hash ^ BigInt(byte)) * 0x1000000000000000000013bn);
  }
  return hash.toString(16).padStart(32, '0');
}

function validateStored(data) {
  if (!data || !Array.isArray(data.tasks) || data.tasks.length > MAX_TASKS ||
      typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt))) {
    throw new Error('Invalid data.json structure.');
  }
  const ids = new Set();
  for (const task of data.tasks) {
    if (!task || typeof task !== 'object') throw new Error('Invalid stored task.');
    const title = cleanText(task.title, 'Title', 1, 300);
    const category = cleanText(task.category, 'Category', 1, 100);
    if (title !== task.title || category !== task.category || task.id !== taskId(category, title) ||
        ids.has(task.id) || !STATUSES.has(task.status) ||
        typeof task.updatedAt !== 'string' || !Number.isFinite(Date.parse(task.updatedAt))) {
      throw new Error('Invalid stored task: ' + task.id);
    }
    if (task.status === 'todo') {
      if (task.owner !== null) throw new Error('Todo tasks must have a null owner.');
    } else if (cleanText(task.owner, 'Owner', 2, 20) !== task.owner) {
      throw new Error('Invalid owner.');
    }
    ids.add(task.id);
  }
  return data;
}

async function save(next) {
  // The queue guarantees a single writer and exclusive use of this temp file.
  const temp = DATA_FILE + '.tmp';
  let handle;
  try {
    handle = await fs.promises.open(temp, 'w');
    await handle.writeFile(JSON.stringify(next, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temp, DATA_FILE);
    state = next; // Publish only after the durable write and atomic rename succeed.
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temp).catch(() => {});
    throw error;
  }
}

function mutate(action) {
  const pending = writeQueue.then(action);
  writeQueue = pending.catch(() => {}); // A failed request must not block later writes.
  return pending;
}

async function readJSON(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    fail('Content-Type must be application/json.', 415);
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) fail('Request is too large (maximum 10 MiB).', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Expected a JSON object.');
  return body;
}

function send(res, status, data, type = 'application/json; charset=utf-8') {
  const body = type.startsWith('application/json') ? JSON.stringify(data) : data;
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  res.end(body);
}

async function route(req, res) {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && STATIC_FILES.has(pathname)) {
      const [filename, type] = STATIC_FILES.get(pathname);
      const content = await fs.promises.readFile(__dirname + '/public/' + filename);
      return send(res, 200, content, type);
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && pathname === '/api/tasks') return send(res, 200, state);
    if (req.method === 'POST' && pathname === '/api/import') {
      const body = await readJSON(req);
      const mode = body.mode === undefined ? 'merge' : body.mode;
      if (!['merge', 'replace'].includes(mode)) fail('Mode must be merge or replace.');
      if (!Array.isArray(body.tasks) || body.tasks.length === 0 || body.tasks.length > MAX_TASKS) {
        fail('Import must contain 1–' + MAX_TASKS + ' tasks.');
      }
      const tasks = body.tasks.map(task => {
        if (!task || typeof task !== 'object' || Array.isArray(task)) fail('Invalid task.');
        const title = cleanText(task.title, 'Title', 1, 300);
        const category = cleanText(task.category, 'Category', 1, 100);
        return { id: taskId(category, title), title, category };
      });
      const result = await mutate(async () => {
        const byId = new Map((mode === 'replace' ? [] : state.tasks).map(task => [task.id, task]));
        let added = 0;
        let existed = 0;
        const now = new Date().toISOString();
        for (const task of tasks) {
          if (byId.has(task.id)) { existed++; continue; }
          byId.set(task.id, { ...task, status: 'todo', owner: null, updatedAt: now });
          added++;
        }
        if (byId.size > MAX_TASKS) fail('Dashboard limit is ' + MAX_TASKS + ' tasks.');
        if (added || mode === 'replace') await save({ tasks: [...byId.values()], updatedAt: now });
        return { added, existed };
      });
      return send(res, 200, result);
    }
    const match = pathname.match(/^\/api\/tasks\/([a-f0-9]{32})$/);
    if (req.method === 'POST' && match) {
      const body = await readJSON(req);
      if (!STATUSES.has(body.status)) fail('Invalid task status.');
      const nickname = cleanText(body.nickname, 'Nickname', 2, 20);
      const task = await mutate(async () => {
        const index = state.tasks.findIndex(item => item.id === match[1]);
        if (index < 0) fail('Task not found. Refresh the dashboard.', 404);
        const now = new Date().toISOString();
        const updated = { ...state.tasks[index], status: body.status,
          owner: body.status === 'todo' ? null : nickname, updatedAt: now };
        const tasks = state.tasks.slice();
        tasks[index] = updated;
        await save({ tasks, updatedAt: now });
        return updated;
      });
      return send(res, 200, task);
    }
    send(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (!error.status) console.error('Request failed:', error);
    if (!res.headersSent && !res.destroyed) send(res, error.status || 500, {
      error: error.status ? error.message : 'Could not save changes. Please try again.',
    });
  }
}

async function main() {
  try {
    state = validateStored(JSON.parse(await fs.promises.readFile(DATA_FILE, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Cannot load data.json; refusing to overwrite it:', error.message);
      process.exitCode = 1;
      return;
    }
    await save({ tasks: [], updatedAt: new Date().toISOString() });
  }
  const server = http.createServer(route);
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('error', error => { console.error('Server error:', error.message); process.exitCode = 1; });
  server.listen(8000, '0.0.0.0', () => {
    console.log('Flagboard: http://localhost:8000');
    console.log('LAN/VPN: http://<this-computer-IP>:8000');
    console.log('Storage: ' + DATA_FILE);
    console.log('Run only one server process per data.json. Press Ctrl+C to stop.');
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close(async () => { await writeQueue; });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => { console.error('Startup failed:', error.message); process.exitCode = 1; });
