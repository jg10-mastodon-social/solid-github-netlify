# solid-github-netlify

![No maintenance intended](https://img.shields.io/badge/no_maintenance_intended-orange) ![Code quality: TDD vibe coded](https://img.shields.io/badge/code_quality-TDD_vibe_coded-orange)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/jg10-mastodon-social/solid-github-netlify#WRITE_WEBIDS=&GITHUB_REPO=octocat/hello-world&GITHUB_REF=HEAD)

Solid-protocol-compatible read/write proxy backed by a GitHub repository. Public reads from `${GITHUB_REPO}@${GITHUB_REF}`; writes go to per-page `${page}-draft` branches via Solid-OIDC-authenticated PUT.

- **Public GET** `GET /:page*/:doc` — unauthenticated. Proxies `${GITHUB_REPO}@${GITHUB_REF}:${page}/${doc}` via the GitHub Contents `application/vnd.github.raw` media type. Forwards `Content-Type` (inferred from the file extension via `mime-types`), `ETag`, and `Cache-Control`; honors `If-None-Match` (returns 304) and emits `Vary: If-None-Match` whenever the client sent one.
- **Public container GET** `GET /`, `GET /:page*/` — unauthenticated. Lists the GitHub directory at `${GITHUB_REPO}@${GITHUB_REF}:${page}/` via the GitHub Contents `application/vnd.github+json` media type and returns a Turtle `ldp:Container, ldp:BasicContainer` document with `ldp:contains` triples pointing to each child (files typed as `ldp:Resource`, subdirectories typed as `ldp:Container, ldp:BasicContainer`). Content-Type is `text/turtle; charset=utf-8`. Honors `If-None-Match` (emits `Vary: If-None-Match`). PUT on container paths is rejected with 405.
- **Draft GET** `GET /:page*/history/draft/:doc`, `GET /:page*/history/draft/` — file and container reads of `${page}-draft`. Same proxy / listing semantics as the public route; falls back to `GITHUB_REF` on a 404.
  - Auth is optional: if both `Authorization` and `DPoP` headers are present, `verifyDpopToken` against `WRITE_WEBIDS` sets `WAC-Allow` to `user="read write", public="read"` for an authenticated allowlisted WebID, else `user="read", public="read"`.
  - **Missing headers are not an error** — anonymous reads are allowed; the auth check only elevates `WAC-Allow`.
- **Draft PUT** `PUT /:page*/history/draft/:doc` — Solid-OIDC-authenticated against `WRITE_WEBIDS`.
  - Creates the `${page}-draft` branch from `GITHUB_REF` if missing, then commits the file.
  - Honors `If-Match` (sha precondition → 412 on mismatch) and `If-None-Match: *` (create-only → 412 if the path exists on the branch).
  - `If-Match` and `If-None-Match: *` are mutually exclusive — sending both returns 400.
- **Draft PATCH** `PATCH /:page*/history/draft/:doc` — Solid-OIDC-authenticated against `WRITE_WEBIDS`.
  - Accepts `Content-Type: text/n3`; only handles the simplest supported shape — a single `solid:InsertDeletePatch` with non-empty `solid:inserts` and empty/absent `solid:where`/`solid:deletes`. Insert triples must be ground (no blank nodes, no variables).
  - Flow: fetch existing from `${page}-draft` (404 means "create from empty"), parse as Turtle, add inserts, re-serialize as `text/turtle; charset=utf-8`, commit.
  - Honors `If-Match` (sha precondition → 412 on mismatch).
  - Errors: other `Content-Type` → 415; non-`.ttl` path → 422; validation failure (blank nodes / variables / present `where` or `deletes` / malformed body / multiple patches) → 422; non-draft URL → 405.
- **History** — LDP-navigable view of past commits on `${GITHUB_REF}` affecting `<page>/*`. Path: `/:page*/history[/YYYY[/MM]]/<shortSha>[/<doc*>]`. Bucket levels (year, month) list children within `[REPO_START_YEAR, currentYear]`; year and month are optional when fetching by `<shortSha>`. Years outside the range return 404, empty months return 200 with no children.
  - Cache: bucket levels `public, max-age=86400, stale-while-revalidate=259200` (1 day fresh, 3 days SWR); commit-SHA levels `public, max-age=31536000, immutable` (the URL is the commit, the response cannot change).
- **CORS** `OPTIONS` — 204 with allow-list `PATCH, PUT, GET, OPTIONS`; allows headers `Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature, If-None-Match, If-Match`; exposes `ETag, Cache-Control, WAC-Allow, Allow, Accept-Put, Accept-Patch`; echoes `Origin` (falls back to `*`); `Vary: Origin`.

**Path safety** — every path goes through `isPathSafe` (no leading `/`, no empty/`./`..`/NUL segments); unsafe paths are rejected with 400. The empty path (root container `/`) is the only exception.

**Errors** — `GitHubFetchError` (network/5xx) and `GitHubApiError` (4xx) carry the upstream status; 5xx is surfaced as 502, 4xx passes through, 404 passes through.

## Prerequisites

- Node.js 18+
- [netlify-cli](https://docs.netlify.com/cli/get-started/) for local development (`npm install -g netlify-cli`)
- A GitHub [fine-grained personal access token](https://github.com/settings/personal-access-tokens) with `contents:write` on the target repository

## Setup

```bash
npm install
```

```bash
npm run build:config
```

Also runs automatically as `netlify.toml`'s `command`, `pretest`, and vitest `globalSetup`. Writes `netlify/functions/router/repo-start-year.generated.mjs` (gitignored). The function itself ships from `netlify/functions/router/` without a TS compile step (Netlify bundles `.mts` directly).

Optional: copy `.env.example` to `.env` and fill in `WRITE_WEBIDS`, `GITHUB_REPO`, `GITHUB_TOKEN`, `GITHUB_REF` for `netlify dev`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WRITE_WEBIDS` | Yes | Comma-separated list of WebIDs allowed to write (PUT). Empty list → no PUTs allowed. |
| `GITHUB_REPO` | Yes | `owner/repo` form. |
| `GITHUB_TOKEN` | Yes | GitHub PAT with `contents:write` on `GITHUB_REPO`. |
| `GITHUB_REF` | No | Ref for public reads and the base for new draft branches (default `HEAD`, which resolves to the repo's default branch on each call). |
| `REPO_START_YEAR` | No | 4-digit year in `[1900, 2100]`. Used directly if set; otherwise `npm run build:config` resolves it from the GitHub repo (public API for public repos, authenticated with `GITHUB_TOKEN` for private repos), and writes `0` if neither works. |

## How it works

**Debugging:** every request handled by the router function logs a single `[router] METHOD /path` entry line at the start (e.g. `[router] PUT /foo/history/draft/bar`). Auth failures additionally log `[router] ${pathname} auth failed: <message>` followed by an `[auth] DENIED: <reason>` line. When the underlying verifier rejects on `iat` clock skew, an `[auth] Token iat timestamp is N seconds ahead/behind server time` line is emitted as well. Grepping for `[router]` or `[auth]` is the fastest way to follow a single request through the function.

### Public GET `/:page*/:doc`

Unauthenticated proxy of `${GITHUB_REPO}@${GITHUB_REF}:${page}/${doc}`.

1. Load `GITHUB_REPO`/`GITHUB_TOKEN`/`GITHUB_REF` from env.
2. Resolve `path = ${page}/${doc}` from `context.params`; reject 400 on unsafe path.
3. `fetchFileFromGitHub` against `https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}` with `Accept: application/vnd.github.raw`, forwarding the request's `If-None-Match`.
4. Read `Content-Type` (preferring the inferred MIME from the file extension), `ETag`, and `Cache-Control` from the upstream response.
5. Add `Vary: If-None-Match` whenever the caller sent an `If-None-Match` (so CDN caches don't collapse 200 and 304 responses).
6. Return the body with the upstream status; 304 short-circuits to an empty body. Upstream 404 passes through to the caller; 5xx is surfaced as `GitHubFetchError` → 502.

### Public container GET `/`, `/:page*/`

Unauthenticated listing of `${GITHUB_REPO}@${GITHUB_REF}:${page}/` as a Turtle `ldp:BasicContainer` document. The container path is derived from the URL pathname (not `context.params`, because Netlify's greedy `:page*` swallows trailing slashes into the previous segment), and an empty pathname `/` lists the repo root.

1. Load `GITHUB_REPO`/`GITHUB_TOKEN`/`GITHUB_REF` from env.
2. Detect container requests via `pathname === '/' || pathname.endsWith('/')`. The container path is the pathname stripped of leading and trailing slashes (root `/` → empty path, which `listDirectoryFromGitHub` translates to the repo-root Contents URL).
3. `listDirectoryFromGitHub` against `https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}` with `Accept: application/vnd.github+json`.
4. If upstream 404, return 404. Otherwise, serialize the entries via `serializeContainer` (see [Repository layout](#repository-layout) for an example). The container is typed `ldp:Container, ldp:BasicContainer`; files are typed `ldp:Resource` and subdirectories are typed `ldp:Container, ldp:BasicContainer`.
5. Set `Content-Type: text/turtle; charset=utf-8`. Add `Vary: If-None-Match` when the caller sent an `If-None-Match`. 5xx is surfaced as `GitHubFetchError` → 502; 4xx surfaces as `GitHubApiError` → 502.

### Draft GET `/:page*/history/draft/:doc` and `/:page*/history/draft/`

Same proxy / listing semantics as the public route, but reads `${page}-draft` (the per-page branch) and falls back to `GITHUB_REF` on a 404. Auth is optional and only affects the `WAC-Allow` response header. The container path is derived from the URL pathname — `/:page*/history/draft/` strips the `/history/draft/` suffix and uses the remaining prefix.

1. Load env; resolve `path`; reject 400 on unsafe path.
2. If the request carries both `Authorization` and `DPoP` headers, run `verifyDpopToken` against `WRITE_WEBIDS`. Anonymous reads (no headers, or one header missing) are not rejected.
3. Fetch from `${page}-draft` (file via `fetchFileFromGitHub`; container via `listDirectoryFromGitHub`), forwarding `If-None-Match`. On a 404 (per-page branch missing or never edited), transparently re-fetch from `GITHUB_REF`. The fallback's `ETag`, `Cache-Control`, and `Vary: If-None-Match` are forwarded unchanged — git blob SHAs are content-addressed, so the same content on `main` and a freshly-created `${page}-draft` has the same SHA, and a `PUT` with `If-Match: "<etag>"` against the draft branch will be accepted. If the fallback also 404s, the caller sees 404 with `WAC-Allow`. 5xx is not retried.
4. Build `WAC-Allow`: `user="read write", public="read"` for an authenticated allowlisted WebID; `user="read", public="read"` for an unauthenticated/anonymous reader. Emitted on every response (200, 304, 404, fallback).
5. Advertise editing capability via Solid-spec-compliant headers (mirrors CommunitySolidServer's behavior): `Allow: GET, PUT, OPTIONS`, `Accept-Put: */*`, `Accept-Patch: text/n3`. The advertised methods apply to **all** draft GET responses (200/304/404 and the fallback case) — `Accept-Patch: text/n3` is advertised even for non-RDF content-types so clients like `rdflib.js` recognize the resource as editable and route PATCH requests accordingly; the handler then enforces the `.ttl`-only constraint on the actual PATCH.
6. On 200, container bodies are serialized as Turtle `ldp:Container, ldp:BasicContainer` (same serializer as the public route) with `Content-Type: text/turtle; charset=utf-8`. Add `Vary: If-None-Match` whenever the caller sent `If-None-Match`.
7. Return the body with the upstream status (304 short-circuits to an empty body).

### Draft PUT `/:page*/history/draft/:doc`

Solid-OIDC-authenticated commit to `${page}-draft`.

1. Load `WRITE_WEBIDS`; verify the DPoP token via `verifyDpopToken` (`Authorization`+`DPoP` bound to `PUT`+`req.url`), allow-listed against `WRITE_WEBIDS`; reject 401 if headers missing, 403 if the WebID isn't allowlisted.
2. Resolve `path = ${page}/${doc}` from `context.params`; reject 400 on unsafe path.
3. Parse `If-Match` (strip weak prefix `W/` and surrounding quotes — only the first comma-separated value is honored) and detect `If-None-Match: *`; reject 400 if both are present (mutually exclusive).
4. Load `GITHUB_REPO`/`GITHUB_TOKEN`/`GITHUB_REF`; `branch = ${page}-draft`.
5. If `If-None-Match: *`, probe `getFileBlobSha({ref: branch, path})`; reject 412 if the path already exists on the branch (create-only).
6. `commitFileOnBranch` (in `src/github.ts`):
   - `getBranchRef({branch})`; if the branch doesn't exist:
     - Resolve `baseRef`: when `GITHUB_REF === 'HEAD'`, call `getDefaultBranch` to look up the repo's default branch; otherwise use `GITHUB_REF` directly.
     - `getBranchRef({branch: baseRef})` to fetch its sha; reject 404 if missing.
     - `createBranchFromSha` to create `${page}-draft` from that sha.
   - `getFileBlobSha({ref: branch, path})` for the sha precondition (overridden by the caller's `If-Match` if present).
   - `commitFile` → `PUT /repos/${repo}/contents/${path}` with base64 body, `branch: ${page}-draft`, `message: Update ${path} via solid-github-netlify`, and `sha` set when known.
7. Return 200 with `{commit, url, branch, path, etag}` and an `ETag: "<contentSha>"` header. On failure:
   - `GitHubApiError` with status 409 **or** status 422 whose message mentions `sha` + `match`/`invalid` → 412 "If-Match failed".
   - Any other `GitHubApiError` → pass through with its status.
   - `GitHubFetchError` → its status (typically 502).
   - Anything else → 502 with `error.message`.

#### Per-branch concurrency / `If-Match` flow

GitHub's Contents API is eventually consistent: two PUTs racing on the same path can both succeed without `If-Match` and silently drop one writer. The router guards writes in two ways, both backed by GitHub's `sha` precondition:

- **`If-Match: "<sha>"`** — caller passes the sha it last saw. The router passes it straight through to GitHub; if the sha no longer matches (someone else committed first), GitHub returns 409 (or 422 with a `sha … match`/`invalid` message), the router maps that to 412 "If-Match failed", and the caller is expected to GET, re-merge, and retry.
- **`If-None-Match: *`** — create-only semantics. The router probes `getFileBlobSha` against the draft branch; if anything is there, it returns 412 "Resource already exists" without ever touching GitHub. If the probe returns nothing, the write proceeds with no sha precondition.

When neither precondition is sent, the router still probes the branch for a current sha and forwards it (best-effort overwrite-with-precondition); the write is then a no-op only if the caller GET'd in the same race window. **This is a best-effort guard, not a global lock** — for correctness, always send `If-Match`.

### Draft PATCH `/:page*/history/draft/:doc`

Solid-OIDC-authenticated N3 Patch pass-through to `${page}-draft`. The router advertises `Accept-Patch: text/n3` on every draft GET so Solid clients (`rdflib.js`, mashlib, etc.) recognize the resource as editable and route PATCH requests through Solid's `solid:InsertDeletePatch` flow.

**Supported patch shape** — only the minimum subset that rdflib.js's single-insert edit produces:

```turtle
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix ex: <http://example.org/>.

_:patch
      solid:inserts {
        ex:alice ex:knows ex:bob .
      };
   a solid:InsertDeletePatch .
```

Requirements enforced by the handler (anything else → 422):

- Exactly **one** resource of type `solid:InsertDeletePatch` in the patch document.
- `solid:where` predicate present ⇒ the formula must be empty. Solved conditions / variable bindings are **not** supported.
- `solid:deletes` predicate present ⇒ the formula must be empty. The router does not perform deletions.
- `solid:inserts` predicate is required and the formula must contain **at least one** ground triple (subject/predicate must be `NamedNode`s; object must be a `NamedNode` or `Literal`).
- No blank nodes or variables anywhere in `solid:inserts`. (Spec §5.3.1 would require freshly-created blank nodes per insert; the router rejects them as out of scope for the M3-insert subset.)

Flow:

1. Load `WRITE_WEBIDS`; verify the DPoP token via `verifyDpopToken` (`Authorization`+`DPoP` bound to `PATCH`+`req.url`), allow-listed against `WRITE_WEBIDS`.
2. Resolve `path = ${page}/${doc}`; reject 400 on unsafe path; reject 405 if the route isn't a draft URL.
3. Validate that `doc` ends in `.ttl` (case-insensitive). Anything else → 422 "PATCH is only supported on .ttl paths". Note: the GET handler still advertises `Accept-Patch: text/n3` for non-`.ttl` draft URLs so capability discovery is consistent, but the PATCH handler enforces this server-side.
4. Validate `Content-Type: text/n3` (parameters ignored). Anything else → 415.
5. Parse `If-Match` if present (strip weak prefix `W/` and surrounding quotes).
6. Fetch the existing file from `${page}-draft` via `fetchFileFromGitHub`. A 404 means "create from empty"; any other upstream status passes through.
7. Hand `body` + `existing` to `applyInsertOnlyTurtlePatch` in `src/patch.ts` (see below). Any validation failure throws `PatchValidationError` → 422 with the message.
8. Commit the merged turtle to `${page}-draft` via `commitFileOnBranch` with the same `If-Match` handling as PUT. On failure: `GitHubApiError` with status 409 or 422 → 412; other `GitHubApiError` → its status; `GitHubFetchError` / anything else → 502.
9. Return 200 with `{commit, url, branch, path, etag}` and `ETag: "<contentSha>"`.

#### `src/patch.ts`

A single function:

```ts
applyInsertOnlyTurtlePatch({ body, existing }: {
  body: Uint8Array         // raw PATCH body, expected to be text/n3
  existing: Uint8Array | null  // null if the file does not exist yet
}): Promise<{ content: string; contentType: 'text/turtle; charset=utf-8' }>
```

Behavior: parses `body` as N3 (so formulae are preserved as `BlankNode`-rooted sub-graphs), locates the single `solid:InsertDeletePatch` resource, gathers the triples inside its `solid:inserts` formula, validates the constraints listed above, then parses `existing` (if present) as Turtle, adds the insert triples, and serializes the resulting graph back to Turtle. Throws `PatchValidationError` (which has a `.status` of 422) on any validation failure; the router maps that to a 422 response.

#### Limitations

The router implements the **minimum M3-insert subset only**. The following Solid-spec features are **not** supported and return 422:

- `solid:where` with variable bindings (the BGP solver / variable-substitution machinery from `solidproject/conformance-test-harness` is out of scope here)
- `solid:deletes` (no deletion is performed; writes are append-only)
- Blank-node generation in `solid:inserts`
- Variables in `solid:inserts`
- Multi-patch documents (`solid:Patch` resources other than the single `solid:InsertDeletePatch`)
- Named-graph patches (`solid:from` / `solid:into`)
- `application/sparql-update` PATCH bodies (would require a SPARQL Update engine)
- PATCH on paths that don't end in `.ttl`
- PATCH on containers

Clients that need full N3 Patch semantics per [Solid Protocol §5.3.1](https://solidproject.org/TR/protocol#modifying-resources-using-n3-patches) should target a Solid server like [CommunitySolidServer](https://github.com/CommunitySolidServer/CommunitySolidServer) instead.

### History routes (LDP-navigable commit history)

The history tree under `/:page*/history/` is an LDP-navigable view of `${GITHUB_REPO}@${GITHUB_REF}`'s commit history affecting `<page>/*`. It is fully read-only and anonymous; mutations flow through the existing draft route.

#### URL matrix

| URL | Response | Backing API calls |
|---|---|---|
| `GET /:page/history` | LDP `BasicContainer` listing years `[REPO_START_YEAR..currentYear]` | **0** |
| `GET /:page/history/YYYY` (in range) | LDP `BasicContainer` of `<MM>/` for months with commits | 1 (date-scoped `listCommitsForPath`) |
| `GET /:page/history/YYYY` (out of range) | 404 | 0 |
| `GET /:page/history/YYYY/MM` | LDP `BasicContainer` of `<shortSha>/` for commits in that month | 1 (date-scoped `listCommitsForPath`) |
| `GET /:page/history/YYYY/MM/<shortSha>` | LDP `BasicContainer` listing immediate children of `<page>/` at that commit | 1 (`listDirectoryFromGitHub`, single-folder, no recursive subtree) |
| `GET /:page/history/<shortSha>` | same as above (year/month prefix optional) | 1 |
| `GET /:page/history/<shortSha>/<doc*>` | file content at that commit | 1 (`fetchFileFromGitHub`) |
| `GET /:page/history/YYYY/MM/<shortSha>/<doc*>` | same as above (year/month prefix ignored) | 1 |

Date-scoped `listCommitsForPath` calls cap at `perPage=100` (the GitHub API's first page). Year/month listings for pages with >100 commits affecting them in a given window are silently truncated — only the first 100 commits are reflected in `<MM>/` or `<shortSha>/` children.

Content negotiation: `Accept: text/turtle` (or absent) → `text/turtle; charset=utf-8`; `Accept: text/html` → `text/html; charset=utf-8`. The HTML form renders a `<ul>` of `<a href>` children, suitable for browser navigation.

#### SHA-robust addressing

The commit SHA in the URL is the source of truth. Year and month segments in the URL are bucket metadata used for LDP navigation; they are not used to resolve the commit. Concretely:

- `/foo/history/abc1234/foo.txt` and `/foo/history/2024/03/abc1234/foo.txt` both fetch `<page>/foo.txt` at commit `abc1234*`. The wrong year/month prefix is ignored.
- `/foo/history/draft` (no `:doc`) returns 404 — the draft route has its own path matcher and is unaffected by the history catch-all.
- SHA validity: 7–40 lowercase hex characters. SHAless URLs (e.g. `/foo/history/2026/`) are valid only as year/month container listings, not as file fetches.

### OPTIONS

204 with CORS allow-list as documented above. No auth, no upstream call.

## Testing

```bash
npm run test:unit          # Pure module tests (no HTTP, no GitHub)
npm run test:integration   # Router handler tests with mocked dependencies
npm run test:e2e           # Real `netlify dev` on port 9999 (boots in-process)
```


```
.
├── netlify/
│   └── functions/
│       └── router/
│           └── router.mts   # GET/PUT/PATCH router for /:page*/:doc, /:page*/history/draft/:doc, and /:page*/history/:rest*
├── netlify.toml             # Build config (runs derive-repo-start-year.mjs) + function routing
├── scripts/
│   └── derive-repo-start-year.mjs   # Build-time step: writes REPO_START_YEAR to a generated .mjs
├── src/
│   ├── auth.ts              # DPoP token verification
│   ├── config.ts            # Env loading (writeWebIds, githubRepo, githubToken, githubRef)
│   ├── github.ts            # GitHub Contents API + refs helpers + commitFileOnBranch + listCommitsForPath
│   ├── history.ts           # parseHistoryPath: pure URL shape -> discriminated union
│   ├── ldp.ts               # LDP BasicContainer Turtle/HTML serializers
│   └── patch.ts             # Minimal N3 Patch (M3-insert subset) parser/applier
├── tests/
│   ├── helpers/             # dev-server spawn (port 9999) + build-config setup
│   ├── unit/                # auth, build-config, config, github, history, ldp, patch, router
│   ├── integration/         # Router handler tests with mocked deps
│   └── e2e/                 # Tests against `netlify dev`
└── LICENSE
```

## Architecture

### Components and trust boundaries

- **Netlify function** (`netlify/functions/router/router.mts`): the only externally reachable surface; stateless across invocations.
  - Route table (`config.path`): `/`, `/:page*/:doc`, `/:page*/`, `/:page*/history/draft/:doc`, `/:page*/history/draft/`, `/:page*/history/:rest*`.
  - Methods (`config.method`): `PATCH, PUT, GET, OPTIONS` with `preferStatic: true` — matching assets in the static `public/` are served first; everything else falls through to the function.
- **GitHub**: durable storage for file contents.
  - Public reads: `${GITHUB_REPO}@${GITHUB_REF}:${page}/${doc}` via `GET /repos/${repo}/contents/${path}?ref=${ref}` with `Accept: application/vnd.github.raw`.
  - Public container listings: `${GITHUB_REPO}@${GITHUB_REF}:${page}/` with `Accept: application/vnd.github+json`.
  - History routes: `GET /repos/${repo}/commits?sha=${branch}&path=${path}&since=...&until=...` (enumerate commits) and `GET /repos/${repo}/contents/${path}?ref=${shortSha}` (fetch a file at a specific commit).
  - Draft reads and writes target `${GITHUB_REPO}@${page}-draft`, which the function creates from `GITHUB_REF` on first PUT per page.
- **OIDC issuer**: any issuer can sign DPoP tokens.
  - Only tokens whose `payload.webid` is in `WRITE_WEBIDS` are accepted on PUT.
  - Draft GET: same allowlist gates the `WAC-Allow` upgrade — anonymous readers (no `Authorization`/`DPoP` headers) and non-allowlisted WebIDs both get `user="read", public="read"` (public read is always permitted); only an authenticated allowlisted WebID elevates to `user="read write", public="read"`.

### Repository layout

A typical repo backing this function looks like:

```
${GITHUB_REPO}/
├── main                              # GITHUB_REF (default branch)
│   ├── foo/bar.txt                   # served by GET /foo/bar (and /foo/history/draft/bar on the draft branch)
│   └── alice/profile.ttl            # served by GET /alice/profile.ttl
└── foo-draft                         # ${page}-draft branch for the /foo/* subtree
│   └── bar.txt                       # modified via PUT /foo/history/draft/bar
└── alice-draft                       # ${page}-draft branch for the /alice/* subtree
    └── profile.ttl                   # modified via PUT /alice/history/draft/profile.ttl
```

Each per-page `${page}-draft` branch is created on first PUT and lives until manually deleted. Public reads and draft reads are isolated to their respective branches — there is no merge step in the function; promoting a draft to `GITHUB_REF` is a separate GitHub-side PR/merge operation.
