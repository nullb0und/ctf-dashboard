'use strict';
// Integration checks use a disposable copy and an automatically assigned port.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const vm = require('node:vm');
const directory = fs.mkdtempSync(path.join(__dirname, '.flagboard-test-'));
fs.copyFileSync(path.join(__dirname, 'server.js'), path.join(directory, 'server.js'));
fs.cpSync(path.join(__dirname, 'public'), path.join(directory, 'public'), { recursive: true });
let child;
let baseURL;
let serverErrors = '';
async function start() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: directory, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + output)), 8000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const address = output.match(/Flagboard: http:\/\/localhost:(\d+)\r?\n/);
      if (address) {
        baseURL = 'http://127.0.0.1:' + address[1];
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', chunk => { output += chunk; serverErrors += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code + ' ' + output)); });
  });
}
async function stop() {
  if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
}
async function request(route, body, expected = 200) {
  const response = await fetch(baseURL + route, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
async function checkHead(route) {
  const url = baseURL + route;
  const get = await fetch(url);
  await get.arrayBuffer();
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, get.status, 'HEAD status: ' + route);
  for (const header of ['content-type', 'content-length', 'cache-control', 'x-content-type-options', 'referrer-policy']) {
    assert.equal(head.headers.get(header), get.headers.get(header), 'HEAD ' + header + ': ' + route);
  }
  assert.equal((await head.arrayBuffer()).byteLength, 0, 'HEAD must have no body: ' + route);
}
async function main() {
  await start();
  const page = await (await fetch(baseURL)).text();
  assert.match(page, /<link rel="stylesheet" href="\/styles.css">/);
  assert.match(page, /<script src="\/app.js" defer>\s*<\/script>/);
  for (const [url, filename, type] of [
    ['/index.html', 'index.html', 'text/html'],
    ['/styles.css', 'styles.css', 'text/css'],
    ['/app.js', 'app.js', 'text/javascript'],
  ]) {
    const response = await fetch(baseURL + url);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    const content = await response.text();
    assert.equal(content, fs.readFileSync(path.join(directory, 'public', filename), 'utf8'));
    if (filename === 'app.js') new vm.Script(content);
  }
  assert.equal(page, fs.readFileSync(path.join(directory, 'public/index.html'), 'utf8'));
  await request('/data.json', undefined, 404);
  await request('/server.js', undefined, 404);
  await request('/public/app.js', undefined, 404);
  await request('/%2e%2e%2fdata.json', undefined, 404);
  assert.equal((await request('/api/tasks')).tasks.length, 0);
  for (const route of ['/', '/index.html', '/styles.css', '/app.js', '/api/tasks', '/favicon.ico', '/missing', '/data.json', '/api/import']) {
    await checkHead(route);
  }
  const tasks = [{ title: ' Cookie monster ', category: 'Web' }, { title: '<img src=x onerror=alert(1)>', category: 'Crypto' }];
  assert.deepEqual(await request('/api/import', { tasks }), { added: 2, existed: 0 });
  let data = await request('/api/tasks');
  const id = data.tasks[0].id;
  await checkHead('/api/tasks'); // Check headers again with imported titles in the response.
  await checkHead('/api/tasks/' + id); // POST-only route must not mutate on HEAD.
  assert.deepEqual(await request('/api/tasks'), data);
  assert.equal(data.tasks[0].title, 'Cookie monster');
  assert.equal(data.tasks[0].owner, null);
  assert.equal(data.tasks[1].title, tasks[1].title);
  let updated = await request('/api/tasks/' + id, { status: 'in_progress', nickname: ' alice ' });
  assert.equal(updated.owner, 'alice');
  const oldTime = updated.updatedAt;
  assert.deepEqual(await request('/api/import', { tasks: [tasks[0], tasks[0]] }), { added: 0, existed: 2 });
  data = await request('/api/tasks');
  assert.equal(data.tasks[0].status, 'in_progress');
  assert.equal(data.tasks[0].owner, 'alice');
  assert.equal(data.tasks[0].updatedAt, oldTime);
  updated = await request('/api/tasks/' + id, { status: 'done', nickname: 'bob' });
  assert.equal(updated.owner, 'bob');
  updated = await request('/api/tasks/' + id, { status: 'todo', nickname: 'alice' });
  assert.equal(updated.owner, null);
  await request('/api/tasks/' + id, { status: 'in_progress', nickname: 'bob' });
  updated = await request('/api/tasks/' + id, { status: 'todo', nickname: 'alice' });
  assert.equal(updated.owner, null);
  await request('/api/tasks/' + id, { status: 'bad', nickname: 'bob' }, 400);
  await request('/api/tasks/' + id, { status: 'done', nickname: 'x' }, 400);
  await request('/api/tasks/' + '0'.repeat(32), { status: 'done', nickname: 'bob' }, 404);
  await request('/api/import', { tasks: [{ title: 'Missing category' }] }, 400);
  await request('/api/import', { tasks: [] }, 400);
  await request('/api/import', { tasks, mode: 'oops' }, 400);
  await request('/api/import', { tasks: [{ title: 'x'.repeat(301), category: 'Web' }] }, 400);
  await request('/api/import', { tasks: [{ title: 'bad\u0000title', category: 'Web' }] }, 400);
  const malformed = await fetch(baseURL + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(malformed.status, 400);
  const wrongType = await fetch(baseURL + '/api/import', { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 415);
  // Concurrent imports must never drop another writer's tasks.
  await Promise.all(Array.from({ length: 30 }, (_, n) => request('/api/import', {
    tasks: [{ title: 'Parallel ' + n, category: 'Race' }],
  })));
  data = await request('/api/tasks');
  assert.equal(data.tasks.length, 32);
  const raceTasks = data.tasks.filter(task => task.category === 'Race');
  await Promise.all(raceTasks.map((task, n) => request('/api/tasks/' + task.id, { status: 'done', nickname: 'solver' + n })));
  data = await request('/api/tasks');
  assert.equal(data.tasks.filter(task => task.status === 'done').length, 30);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'data.json'), 'utf8')), data);
  assert.equal(fs.existsSync(path.join(directory, 'data.json.tmp')), false);
  // A disk failure must leave both memory and the last committed file unchanged.
  fs.mkdirSync(path.join(directory, 'data.json.tmp'));
  await request('/api/tasks/' + id, { status: 'done', nickname: 'alice' }, 500);
  assert.deepEqual(await request('/api/tasks'), data);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'data.json'), 'utf8')), data);
  fs.rmdirSync(path.join(directory, 'data.json.tmp'));
  await request('/api/tasks/' + id, { status: 'done', nickname: 'alice' });
  await stop();
  await start();
  data = await request('/api/tasks');
  assert.equal(data.tasks.find(task => task.id === id).owner, 'alice');
  assert.deepEqual(await request('/api/import', { tasks: [tasks[0], tasks[0]], mode: 'replace' }), { added: 1, existed: 1 });
  data = await request('/api/tasks');
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].id, id);
  assert.equal(data.tasks[0].status, 'todo');
  assert.equal(data.tasks[0].owner, null);
  await stop();
  fs.writeFileSync(path.join(directory, 'data.json'), '{broken');
  child = spawn(process.execPath, ['server.js'], { cwd: directory, stdio: 'ignore' });
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 1);
  assert.equal(fs.readFileSync(path.join(directory, 'data.json'), 'utf8'), '{broken');
  console.log('PASS: HEAD status/headers/empty bodies, frontend assets and MIME types, private-file protection, imports, stable IDs, transitions, validation, 60 concurrent writes, atomic failure recovery, restart persistence, corrupt-file refusal, and frontend syntax.');
}
main().catch(error => {
  console.error(error);
  if (serverErrors) console.error('Server diagnostics:\n' + serverErrors);
  process.exitCode = 1;
}).finally(async () => {
  await stop();
  // Verify the resolved target stays inside this workspace before recursive cleanup.
  const target = path.resolve(directory);
  if (path.dirname(target) === path.resolve(__dirname) && path.basename(target).startsWith('.flagboard-test-')) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
