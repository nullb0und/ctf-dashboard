# Flagboard

A minimal CTF team dashboard with a compact, terminal-style interface based on the supplied Figma design. No packages or build step; only Node's built-in `http` and `fs` modules.

## Files

- `server.js`: HTTP API, validation, and atomic JSON storage.
- `public/index.html`: page markup.
- `public/styles.css`: dark theme and responsive layout.
- `public/app.js`: task rendering, XML parsing, nickname cookies, and polling.
- `data.json`: task data, created automatically.
- `example.xml`: sample import.
- `test.js`: integration checks.

## Run

Install Node.js 18 or newer, then run from this folder:

```sh
node server.js
```

Open **http://localhost:8000**. Teammates use **http://YOUR-LAN-OR-VPN-IP:8000**. The server listens on `0.0.0.0:8000`; allow incoming TCP port 8000 in your firewall if needed. Stop with Ctrl+C.

Set the `PORT` environment variable to override the default port (for example, on Render). `PORT=0` asks the OS to assign a free port, which the test suite uses.

`data.json` is created automatically beside `server.js`, regardless of the working directory. Updates are serialized, flushed to `data.json.tmp`, and atomically renamed into place before becoming visible. Run **one server process per data file**. A malformed existing data file causes startup to fail without overwriting it. Back up `data.json` to preserve your team's progress.

## Use

- Choose a nickname (2–20 trimmed characters). It is saved in the `nickname` cookie for one year. Use **change** in the header to edit it.
- **Import XML** or drop one XML file anywhere to merge tasks. Existing tasks keep their status and owner.
- **Replace all** opens a file picker, validates the XML, then asks for confirmation. Replacement resets all imported tasks to Not solved and removes all previous tasks.
- **Take** assigns In progress to your nickname. **Done** records the nickname of whoever clicks it. **Release** and **Reopen** clear the owner and return the task to Not solved. Anyone may update any task; nicknames are labels, not accounts.
- Task rows show **TODO**, **WIP**, or **DONE**, with the owner's nickname in a separate column. Your in-progress tasks appear in the cyan **MY TASKS** section with a **YOU** badge. **[ONLY MINE]** filters to them. Use **[ALL]**, **[TODO]**, **[WIP]**, and **[DONE]** to filter by status; press `/` to focus search. Search, filters, category collapse state, and scroll position survive polling updates.
- The page polls every 3 seconds. When the server is unreachable, the last loaded tasks remain visible with a connection indicator. Failed writes show an error; retry after connectivity returns.

## XML format

Tasks may appear at any depth. Names are case insensitive and namespace prefixes are supported. Title and category can each be a direct child or attribute (a nonempty attribute takes precedence):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ctf>
  <round>
    <task title="Cookie monster" category="Web" />
    <task>
      <title>Hidden message</title>
      <category>Crypto</category>
    </task>
    <task category="Forensics"><title>Memory lane</title></task>
  </round>
</ctf>
```

Invalid XML, missing fields, or invalid task data rejects the whole import. Limits: 10 MiB per file/request, 20,000 tasks total, titles 1–300 characters, categories 1–100 characters. Surrounding whitespace is trimmed; control characters are rejected. Browser character counts use JavaScript string length. XML is parsed in the browser with `DOMParser`; only title/category JSON is sent to the backend. No XML file is stored.

IDs are deterministic FNV-1a 128-bit hashes of the UTF-8 JSON tuple `[category, title]` after trimming. Category/title matching is case sensitive. Changing either creates a new identity; uploading the same pair again does not. Duplicate rows within an upload count as already existed. For replace mode, counts are relative to the new, initially empty collection.

## API

API responses are JSON. The frontend is served at `/` (or `/index.html`), `/styles.css`, and `/app.js`. Errors use an appropriate HTTP status and `{ "error": "message" }`.

Every GET endpoint also supports HEAD, returning the same status and headers (including Content-Length) with an empty body. This supports hosting health checks and uptime monitors without downloading the page or task list. HEAD never changes task data.

```text
GET /api/tasks
  -> { tasks: [{ id, title, category, status, owner, updatedAt }], updatedAt }

POST /api/import
  Content-Type: application/json
  { "tasks": [{ "title": "Cookie monster", "category": "Web" }], "mode": "merge" }
  -> { "added": 1, "existed": 0 }
  mode: "merge" (default) or "replace"

POST /api/tasks/:id
  Content-Type: application/json
  { "status": "in_progress", "nickname": "alice" }
  -> updated task
  status: "todo", "in_progress", or "done"
```

Import ignores client-supplied IDs/statuses/owners and computes new tasks on the server. `todo` always stores `owner: null`; other states store the supplied trimmed nickname. Timestamps use UTC ISO 8601; the UI displays local time. Simultaneous writes execute in arrival order at the write queue, with the last committed update winning for a task. Imported text is rendered using `textContent` to prevent HTML/script injection.

Intended for a trusted team LAN/VPN: there are deliberately no passwords, accounts, or access restrictions.

## Check

Run `node test.js`. This uses a disposable data directory and an automatically assigned port to verify HEAD responses, frontend asset serving, API validation, imports, state changes, concurrent writes, atomic save failure recovery, restart persistence, and frontend syntax. Your running dashboard can stay open. Keep `server.js` and the `public` directory together when copying the app.
