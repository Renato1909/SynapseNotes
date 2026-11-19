# SynapseNotes — Architecture

How the pieces fit: an npm-workspaces TypeScript monorepo where a Cloudflare Worker serves REST + the SPA, and one Durable Object per note owns the collaborative document.

```
        Browser — React SPA (apps/web)
          │  fetch /api/*                │  wss://…/collab/<noteId>
          ▼                              ▼
 ┌───────────────────────────────────────────────────────┐
 │ Cloudflare Worker (apps/server/src)                   │
 │  worker.ts   dispatch: collab → mode → CORS → table   │
 │  router.ts  14-route contract table                   │
 │  auth.ts / notes.ts / security.ts                     │
 │  assets      apps/web/dist (SPA fallback; /api/* and  │
 │              /collab/* run the Worker first)          │
 └──────────┬────────────────────────────┬───────────────┘
            │ D1 (SQL)                  │ stub.fetch('/connect', X-User-*)
            ▼                           ▼
 ┌─────────────────────┐     ┌─────────────────────────────┐
 │ D1: users, sessions,│     │ NoteRoom DO — 1 per note    │
 │ notes, note_members,│     │ Y.Doc + Awareness           │
 │ rate_limits         │     │ SQLite-backed storage       │
 └─────────────────────┘     │ hibernation WebSockets      │
                             └─────────────────────────────┘
```

## Workspaces

| Workspace | Role |
| --- | --- |
| `packages/shared` | The single source of truth both sides import: route contracts, validation helpers, the binary frame protocol (`protocol.ts`), shared types. |
| `apps/server` | The Worker: HTTP routing, auth, sharing, and the `NoteRoom` Durable Object class (exported from the Worker entry). |
| `apps/web` | The SPA: pages, the two editors, the Yjs collab provider, UI components. |

Nothing in `apps/web` imports `apps/server` (enforced by the lint), and everything that must agree on both sides lives in `shared`.

## HTTP API

`router.ts` declares a route table — `{ id, method, path | pattern }` — that `worker.ts` matches after two special branches (collab upgrade, mode switch). Contract tests assert unique ids and matching precedence, so adding a route means adding one table row plus one handler.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness probe (anonymous) |
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Start session, sets cookie |
| POST | `/api/auth/logout` | Delete session |
| GET | `/api/auth/me` | Current session user |
| GET | `/api/notes` | Notes the caller owns or belongs to |
| POST | `/api/notes` | Create note (title + mode) |
| GET | `/api/notes/:id` | Note detail + caller role |
| PUT | `/api/notes/:id` | Update title (and mode for owners) |
| DELETE | `/api/notes/:id` | Delete note (owner only) |
| GET/POST | `/api/notes/:id/members` | List / invite members by e-mail (`editor` \| `viewer`) |
| PUT/DELETE | `/api/notes/:id/members/:userId` | Change role / remove member (owner only) |
| PUT | `/api/notes/:id/mode` | Persist mode + notify the room (owner/editor) |
| GET | `/collab/:noteId` | WebSocket upgrade → `NoteRoom` |

Responses are JSON with the shape `{ ... }` or `{ error }`; errors carry an HTTP status plus a stable `code`. Mutating routes require an `Origin` header covered by the allow-list (below).

## Realtime: from WebSocket to Durable Object

1. The client opens `wss://<host>/collab/<noteId>` with its session cookie (same origin, so `SameSite=Lax` sends it).
2. `worker.ts` matches the collab branch **before** anything else, validates the session (`security.ts` → `sessions` table) and resolves the caller's role against `notes`/`note_members`. No session → `401`, no access → `404`.
3. The Worker forwards the upgrade to `env.NOTES.get(idFromName(noteId))` using the internal URL `http://do/connect` — the `NoteRoom` routes by pathname — and passes identity via headers the client cannot forge: `X-User-Id`, `X-User-Role`, `X-Note-Id`, `X-Note-Mode`, plus `Upgrade: websocket`.
4. `NoteRoom.handleUpgrade` accepts the socket through the **WebSocket hibernation API** (`state.acceptWebSocket`) and pushes the handshake:
   - `0x01` sync **step 1** (server state vector),
   - `0x01` sync **step 2** (full document as seen by the server),
   - `0x02` awareness (everyone currently present),
   - `0x03` control `hello { role, mode }`.
5. It returns `101` to the browser. Because of step 2, even read-only viewers receive the whole document without asking.

### Frame protocol

Defined once in `packages/shared/src/protocol.ts`: `[1 byte type][payload]`.

| Byte | Type | Payload | Direction |
| --- | --- | --- | --- |
| `0x01` | sync | `y-protocols/sync` message (step 1 / step 2 / update) | both ways |
| `0x02` | awareness | `y-protocols/awareness` update (carets, selection) | both ways |
| `0x03` | control | JSON `ControlEvent` | server → client |

Control events: `hello { role, mode }`, `mode-changed { mode }`, `error { code: 'forbidden' | 'not_found' | 'rate_limited', message }`. Unknown frame types are dropped, strings are ignored, messages larger than **512 KB** are rejected with an `error` control frame.

## NoteRoom internals

- **Boot** — the constructor runs `blockConcurrencyWhile(loadDoc)`: a `Y.Doc` is rebuilt from storage key `ydoc` (full encoded state, base64). A corrupt payload starts an empty room instead of crashing it.
- **Writes** — client `0x01` frames go through `readSyncMessage`; applied updates fire `doc.on('update')`, which broadcasts to every socket *except* the origin and schedules a **1 s debounced persist**. The last disconnect flushes immediately.
- **Viewers** — `0x01` frames from connections whose role is `viewer` are dropped silently. Awareness frames are still accepted so read-only participants show up in presence.
- **Awareness bookkeeping** — each connection tracks the awareness client-ids it introduced, so a disconnect removes exactly that person's caret (`removeAwarenessStates`).
- **Caps** — max **30 clients** per room (`429` beyond that), max 512 KB per message.
- **Control endpoints** the Worker calls on the DO: `PUT /mode` (broadcast `mode-changed`), `DELETE /members` (close that user's sockets with code `4003 acesso_removido`). Anything else → `404`.
- **Mode on connect** — `hello` carries the mode re-read from D1 at upgrade time, so reconnects always learn the persisted value.

The DO keeps the room alive while sockets are open and hibernates between messages; document state lives in the DO's own storage, not in memory alone.

## Mode switching (rich ⇄ Markdown)

The same `Y.Doc` carries **two structures**: rich content in `Y.XmlFragment('default')` (bound to TipTap via `y-prosemirror`) and Markdown source in `Y.Text('markdown')` (bound to CodeMirror via `y-codemirror.next`).

1. **Convert first, locally.** Clicking the toggle converts *into the target structure* before anything else: rich → Markdown serializes the fragment through the TipTap schema and replaces the `Y.Text` in one transaction; Markdown → rich parses the `Y.Text` (markdown-it → TipTap JSON with camelCase attributes) and rewrites the fragment. Conversion is pure client-side and unit-tested for round-trip stability.
2. **Persist.** The page issues `PUT /api/notes/:id/mode`; the Worker re-checks the role (viewer → `403`), runs `UPDATE notes SET mode = …` in D1 *before* notifying the room, then calls the DO.
3. **Broadcast.** `NoteRoom` emits `mode-changed`; every other open tab switches its editor immediately. Server control events take precedence over the REST-loaded note state in the UI, which prevents a late `GET` from clobbering a live switch.

Because both structures live in the doc, switching back and forth converts rather than loses content.

## Auth and sessions

- **Register** validates name, e-mail and password (≥ 8 chars with letters **and** digits) and stores a PBKDF2-SHA256 hash (**100,000** iterations, Web Crypto) — never the password.
- **Login** verifies the hash, mints a random token and returns it as the `synapsenotes_session` cookie: `HttpOnly; Secure; SameSite=Lax`, 7-day TTL. Only the token's SHA-256 hash is stored in `sessions` (`token_hash`), so a database leak does not hand out live sessions.
- Every authenticated request resolves the row through `authenticatedUser`; expiry is checked per request, and logout deletes the row.

## Security posture

| Concern | Mechanism |
| --- | --- |
| CSRF | `SameSite=Lax` cookie + `Origin` allow-list on mutations (`ALLOWED_ORIGINS` var ∪ the request's own origin; CORS preflight for cross-origin callers) |
| Brute force | `AUTH_RATE_LIMITER` (10/min) on register/login, `WRITE_RATE_LIMITER` (30/min) on note/member writes; the D1 `rate_limits` table acts as fallback when no binding is present (tests, plain local) |
| Authorization | Roles resolved server-side per REST call; snapshot passed to the DO at connect; viewers cannot write to the document; owner-only operations guarded in the handlers |
| Trust boundary | The Worker → DO hop passes identity only via headers set by the Worker; the DO never trusts the client URL |
| Input | Shared validators (title ≤ 120, e-mail ≤ 254, password rules),512 KB frame cap, parameterized SQL everywhere |

## Data model

Five tables (see `apps/server/migrations/0001_initial.sql`):

- `users` — id, name, unique e-mail (`COLLATE NOCASE`), `password_hash`.
- `sessions` — `token_hash` (PK), `user_id`, `expires_at`.
- `notes` — UUID, title, `mode` (`CHECK` in `rich`/`markdown`), `owner_id`, timestamps.
- `note_members` — `(note_id, user_id)` PK, role `editor`|`viewer`.
- `rate_limits` — fixed-window fallback buckets.

The document content itself is **not** in D1: it lives in the `NoteRoom`'s SQLite-backed storage; D1 holds metadata (title, mode, ownership, members).

## Testing strategy

- `test-support/MockD1.ts` is an in-memory D1 that **executes the real migration SQL**, so tests cannot drift from the schema.
- Worker tests drive `worker.fetch` end-to-end (cookies, origins, status codes) — the same entry point Cloudflare uses, minus the network.
- The route table is asserted as a contract (unique ids, path vs. pattern, precedence), the frame protocol and both converters are tested pure-functionally, and every lint rule ships with a fixture proving it fires.
- Gaps that only a real deployment can catch (asset routing, hibernation, real D1) were closed by an end-to-end browser pass against the deployed Worker.

## Local development environments

Standard flow is `npm run dev` (local `wrangler dev` + Vite). Two caveats:

1. On some Windows 11 machines the local `workerd` binary crashes at startup ([cloudflare/workerd#4668](https://github.com/cloudflare/workerd/issues/4668)). Use WSL2, or develop against the deployed Worker with `SYNAPSE_PROXY_TARGET` (see the README).
2. `wrangler dev --remote` still boots a local `workerd` (remote *bindings*, local runtime), so it is only an option where the local runtime works.

## Known limitations

- **Titles are not live-synced.** Title edits travel over REST only; open tabs in the same note show the old title until reloaded. (Content, mode, presence and removals *are* live.)
- **Role changes apply to new connections.** The DO snapshots `X-User-Role` at connect time, so demoting an editor to viewer takes effect on their next connect — an already-open socket keeps writing until it reconnects. Member *removal* is immediate: the Worker calls `DELETE /members` and the DO closes those sockets (`4003`).
- **No file uploads.** The image extension inserts by URL only; there is no blob storage.
- **Single-bundle SPA.** ~1.46 MB raw / ~487 kB gzip in one chunk; no route-level code splitting yet.
- **Room scale is deliberately small** — 30 sockets and 512 KB messages per note fit the portfolio scope, not an enterprise workload.
