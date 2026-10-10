# solid-github-netlify

![No maintenance intended](https://img.shields.io/badge/no_maintenance_intended-orange) ![Code quality: TDD vibe coded](https://img.shields.io/badge/code_quality-TDD_vibe_coded-orange)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/jg10-mastodon-social/solid-github-netlify#OWNER_WEBIDS=&GITHUB_REPO=octocat/hello-world&GITHUB_REF=HEAD)

Solid-protocol-compatible read/write proxy backed by a GitHub repository. Public reads from `${GITHUB_REPO}@${GITHUB_REF}`; writes go to per-page `${page}-draft` branches via Solid-OIDC-authenticated PUT.

- **Public GET** `GET /:page*/:doc` — unauthenticated. Proxies `${GITHUB_REPO}@${GITHUB_REF}:${page}/${doc}` via the GitHub Contents `application/vnd.github.raw` media type. Forwards `Content-Type` (inferred from the file extension via `mime-types`) and `ETag`; edge-caches with `Netlify-CDN-Cache-Control: public, durable, max-age=60, stale-while-revalidate=86400` (see [Caching and WAC-Allow](#caching-and-wac-allow)); honors `If-None-Match` (returns 304) and emits `Vary: If-None-Match` whenever the client sent one.
  - **Root-level files** (URLs with no page prefix, e.g. `GET /index.ttl`) are served as-is from the repo root: `${GITHUB_REPO}@${GITHUB_REF}:<doc>`. Forwards the upstream `Content-Type` on 2xx (preferring the extension-guessed MIME when GitHub's raw media type `application/vnd.github.raw` is otherwise generic) and the upstream `Content-Type` on non-2xx (so 404s surface as `application/json`, not `text/turtle`). The corresponding draft branch is the literal name `draft` (no `-draft` suffix because there's no page name to suffix).
- **Public container GET** `GET /`, `GET /:page*/` — unauthenticated. Lists the GitHub directory at `${GITHUB_REPO}@${GITHUB_REF}:${page}/` via the GitHub Contents `application/vnd.github+json` media type and returns a Turtle `ldp:Container, ldp:BasicContainer` document with `ldp:contains` triples pointing to each child (files typed as `ldp:Resource`, subdirectories typed as `ldp:Container, ldp:BasicContainer`). Content-Type is `text/turtle; charset=utf-8`. Edge-cached like the file route. Honors `If-None-Match` (emits `Vary: If-None-Match`). PUT on container paths is rejected with 405. Page-root responses (`/` and `/:page*/`) additionally carry three provenance/memento triples on the container subject (omitted if no commit affects the page — see [Public container GET `/:page*/`](#public-container-get-page)): `<http://mementoweb.org/ns#memento>`, `owl:sameAs`, and `prov:wasGeneratedBy`. **Directory-index behavior:** if the request's `Accept` header prefers `text/html` (or `application/xhtml+xml`) over `text/turtle`/`text/n3`, the router first attempts to serve `<page>/index.html` from `${GITHUB_REPO}@${GITHUB_REF}` (or `index.html` at the repo root for `GET /`); the upstream status, `Content-Type`, and `ETag` are forwarded, the response is edge-cached like the other public reads, and `Vary: If-None-Match` is added when the client sent `If-None-Match`. A `404` from the index lookup falls back to the Turtle container listing. Missing `Accept`, `*/*`, or an `Accept` that doesn't mention either HTML or Turtle all default to the existing Turtle behavior.
- **Draft GET** `GET /:page*/history/draft/:doc`, `GET /:page*/history/draft/` — file and container reads of `${page}-draft`. Same proxy / listing semantics as the public route; falls back to `GITHUB_REF` on a 404. The same Accept-header rule applies: when HTML is preferred over Turtle, the router first tries `<page>/index.html` on `${page}-draft` and serves it read-only (`WAC-Allow: user="read", public="read"`; no `Allow`/`Accept-Put`/`Accept-Patch`; `Cache-Control: private, no-store`); a `404` from the index lookup falls back to the existing draft Turtle listing. With no page prefix (`GET /history/draft/<doc>` and `GET /history/draft/`) the draft branch is the literal name `draft` and the file path is just `<doc>`. A no-page-prefix **subdirectory** container (`GET /history/draft/<sub>/`) likewise lists `<sub>` on the literal `draft` branch (falling back to `GITHUB_REF` on a 404), keeping the root page's draft tree navigable — e.g. `GET /history/draft/topics/` lists the `topics` directory.
  - Auth is optional: if both `Authorization` and `DPoP` headers are present, the DPoP token is verified and `WAC-Allow` reports the requesting agent's modes under `user`; an unauthenticated request reports the public modes under both `user` and `public` (public access implies user access, matching CommunitySolidServer).
  - **Missing headers are not an error** — anonymous reads are allowed; the auth check only elevates `WAC-Allow`.
  - **Not cached** — every draft response carries `Cache-Control: private, no-store` and `Netlify-CDN-Cache-Control: no-store`, because `WAC-Allow` varies per request and a shared cache would leak one user's write capability to another. `Vary: Origin, Authorization, DPoP` advertises the request headers the cache key must include.
- **Draft PUT** `PUT /:page*/history/draft/:doc` — Solid-OIDC-authenticated; authorized by WAC (`write` on the target, plus `append`/`write` on the containing container when creating it).
  - Creates the `${page}-draft` branch from `GITHUB_REF` if missing, then commits the file.
  - Honors `If-Match` (sha precondition → 412 on mismatch) and `If-None-Match: *` (create-only → 412 if the path exists on the branch).
  - `If-Match` and `If-None-Match: *` are mutually exclusive — sending both returns 400.
  - With no page prefix (`PUT /history/draft/<doc>`) the draft branch is the literal name `draft` and the file path is just `<doc>`.
- **Draft PATCH** `PATCH /:page*/history/draft/:doc` — Solid-OIDC-authenticated; authorized by WAC (`write` on the target, or `append` for insert-only edits).
  - Accepts `Content-Type: text/n3`; handles a single `solid:InsertDeletePatch` with non-empty `solid:inserts` and/or ground `solid:deletes` (no variables) and empty/absent `solid:where`. All insert/delete triples must be ground (no blank nodes, no variables).
  - Flow: fetch existing from `${page}-draft` (404 means "create from empty"), parse as Turtle, apply deletes-then-inserts, re-serialize as `text/turtle; charset=utf-8`, commit.
  - Honors `If-Match` (sha precondition → 412 on mismatch).
  - Errors: other `Content-Type` → 415; non-`.ttl` path → 422; validation failure (blank nodes / variables / present `where` / malformed body / multiple patches) → 422; delete triple not present in the document → 409; non-draft URL → 405.
  - With no page prefix (`PATCH /history/draft/<doc>`) the draft branch is the literal name `draft` and the file path is just `<doc>`.
- **History** — LDP-navigable view of past commits on `${GITHUB_REF}` affecting `<page>/*`. Path: `/:page*/history[/YYYY[/MM]]/<shortSha>[/<doc*>]`. Bucket levels (year, month) list children within `[REPO_START_YEAR, currentYear]`; year and month are optional when fetching by `<shortSha>`. Years outside the range return 404, empty months return 200 with no children.
  - Cache: bucket levels `public, max-age=86400, stale-while-revalidate=259200` (1 day fresh, 3 days SWR); commit-SHA levels `public, max-age=31536000, immutable` (the URL is the commit, the response cannot change).
- **Changelog root GET** `GET /:page*/history/changelog/` — unauthenticated. The ActivityPub `as:OrderedCollection` root; lists year sub-containers (301 redirect from the no-slash form).
- **Changelog year GET** `GET /:page*/history/changelog/YYYY/` — unauthenticated. Lists month sub-containers for that year (301 redirect from the no-slash form).
- **Changelog month GET** `GET /:page*/history/changelog/YYYY/MM` — unauthenticated. The synthesized activities for that month, inline as an `as:OrderedCollectionPage` with `as:prev`/`as:next` to sibling months. **Reads the shard from `${page}-draft` first** (so any pending month-PATCH edits on the draft branch are visible); falls back to `GITHUB_REF` on 404. The response body is canonical — identical for every reader regardless of authentication; only `WAC-Allow` varies per request.
- **Changelog month PATCH** `PATCH /:page*/history/changelog/YYYY/MM` — Solid-OIDC-authenticated; authorized by WAC (`write`, or `append` for insert-only edits). Buffers an edit to the past-month shard on `${page}-draft`. Same `text/n3` patch constraints as the draft PATCH.
- **Changelog POST** `POST /:page*/history/changelog/` — Solid-OIDC-authenticated; authorized by WAC (`append` or `write` on the changelog container `/:page*/history/changelog/`). Publishes a new activity: blank-node `prov:Activity` in Turtle with `rdfs:label` as the commit message (required). One main commit per POST; the draft branch is squash-merged in and deleted.
- **CORS** `OPTIONS` — 204 with allow-list `POST, PATCH, PUT, GET, OPTIONS`; allows headers `Authorization, DPoP, Content-Type, Accept, Accept-Charset, Accept-Datetime, Cache-Control, Date, Digest, If-Match, If-None-Match, Link, Prefer, Range, Signature, Slug, Want-Digest` (full Solid-protocol set); `Access-Control-Allow-Credentials: true` so credentialed writes succeed; exposes `ETag, Cache-Control, WAC-Allow, Allow, Accept-Put, Accept-Patch, Accept-Post`; echoes `Origin` (falls back to `*` when no Origin header is sent); `Vary: Origin`. Draft and changelog GETs additionally advertise `Vary: Authorization, DPoP` so caches don't collapse the `WAC-Allow` variants across authenticated/anonymous callers.
- **Access control (WAC)** — public reads stay open; `write`/`append`/`control` permissions follow [Web Access Control](https://solidproject.org/TR/wac), are managed via the `<path>.acl` resource, and every permission change is viewable in an audit log.

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

Optional: copy `.env.example` to `.env` and fill in `OWNER_WEBIDS`, `GITHUB_REPO`, `GITHUB_TOKEN`, `GITHUB_REF` for `netlify dev`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OWNER_WEBIDS` | Yes | Comma-separated WebIDs seeded with `acl:Control`, `acl:Read`, and `acl:Write` on the root scope at bootstrap. They also always retain `acl:Control` on every `.acl` resource (see [Owner protection](#owner-protection-loss-of-control)). |
| `GITHUB_REPO` | Yes | `owner/repo` form. |
| `GITHUB_TOKEN` | Yes | GitHub PAT with `contents:write` on `GITHUB_REPO`. |
| `GITHUB_REF` | No | Ref for public reads and the base for new draft branches (default `HEAD`, which resolves to the repo's default branch on each call). |
| `REPO_START_YEAR` | No | 4-digit year in `[1900, 2100]`. Used directly if set; otherwise `npm run build:config` resolves it from the GitHub repo (public API for public repos, authenticated with `GITHUB_TOKEN` for private repos), and writes `0` if neither works. |
| `ACL_STORE` | No | Netlify Blobs store holding the authoritative WAC policy document (default `acl`). Never written to `GITHUB_REPO`. |
| `ACL_AUDIT_STORE` | No | Netlify Blobs store holding the append-only, hash-chained ACL audit ledger (default `acl-audit`). |

## How it works

**Debugging:** every request handled by the router function logs a single `[router] METHOD /path` entry line at the start (e.g. `[router] PUT /foo/history/draft/bar`). Auth failures additionally log `[router] ${pathname} auth failed: <message>` followed by an `[auth] DENIED: <reason>` line. When the underlying verifier rejects on `iat` clock skew, an `[auth] Token iat timestamp is N seconds ahead/behind server time` line is emitted as well. Grepping for `[router]` or `[auth]` is the fastest way to follow a single request through the function.

### Public GET `/:page*/:doc`

Unauthenticated proxy of `${GITHUB_REPO}@${GITHUB_REF}:${page}/${doc}`.

1. Load `GITHUB_REPO`/`GITHUB_TOKEN`/`GITHUB_REF` from env.
2. Resolve `path = ${page}/${doc}` from `context.params`; reject 400 on unsafe path.
3. `fetchFileFromGitHub` against `https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}` with `Accept: application/vnd.github.raw`, forwarding the request's `If-None-Match`.
4. Read `Content-Type` (preferring the inferred MIME from the file extension) and `ETag` from the upstream response, and set the public edge-cache headers (`Netlify-CDN-Cache-Control: public, durable, max-age=60, stale-while-revalidate=86400`; see [Caching and WAC-Allow](#caching-and-wac-allow)).
5. Add `Vary: If-None-Match` whenever the caller sent an `If-None-Match` (so CDN caches don't collapse 200 and 304 responses).
6. Return the body with the upstream status; 304 short-circuits to an empty body. Upstream 404 passes through to the caller; 5xx is surfaced as `GitHubFetchError` → 502.

### Public container GET `/`, `/:page*/`

Unauthenticated listing of `${GITHUB_REPO}@${GITHUB_REF}:${page}/` as a Turtle `ldp:BasicContainer` document. The router loads `GITHUB_REPO`/`GITHUB_TOKEN`/`GITHUB_REF`, derives the container path from the URL pathname (not `context.params`, because Netlify's greedy `:page*` swallows trailing slashes into the previous segment; root `/` → empty path, which `listDirectoryFromGitHub` translates to the repo-root Contents URL), and rejects unsafe paths with 400.

1. **Content negotiation.** The router checks `Accept` first: if the HTML family (`text/html`, `application/xhtml+xml`) outscores the Turtle family (`text/turtle`, `text/n3`) by q-value (or by order on tie), it attempts `fetchFileFromGitHub` for `<page>/index.html` (or `index.html` for `GET /`) against the same `ref`. On 200/304 it returns that file with the upstream `Content-Type` and `ETag`, the public edge-cache headers, and `Vary: Accept, If-None-Match`; the URL stays `/:page*/` (no redirect). On any other status (404 included), or when `Accept` is missing/`*/*`/mentions neither family, it falls through to the Turtle listing below. Because one URL serves two representations, both the HTML index and the Turtle listing carry `Vary: Accept`, so the edge caches the variants separately and a Turtle request is never served a cached HTML body (or vice versa).
2. `listDirectoryFromGitHub` against `https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}` with `Accept: application/vnd.github+json`.
3. If upstream 404, return 404. Otherwise, serialize the entries via `serializeContainer` (see [Repository layout](#repository-layout) for an example). The container is typed `ldp:Container, ldp:BasicContainer`; files are typed `ldp:Resource` and subdirectories are typed `ldp:Container, ldp:BasicContainer`.
4. **Page-root provenance/memento triples** — for `/` and `/:page*/` (not the draft view), the container subject additionally carries three server-managed triples pointing to its HEAD-mirrored SHA container:
   - `<http://mementoweb.org/ns#memento> <pageUrl>/history/<latestShortSha>/` — custom "has-memento" predicate naming the per-commit container that mirrors this page's current state.
   - `<http://www.w3.org/2002/07/owl#sameAs> <pageUrl>/history/<latestShortSha>/` — same-entity link to the same per-commit container.
   - `<http://www.w3.org/ns/prov#wasGeneratedBy> <pageUrl>/history/changelog/<YYYY>/<MM>#<latestShortSha>` — the synthesized `prov:Activity` in the changelog that produced this version (year/month derived from the latest commit's author date).
   
   `<pageUrl>` is `${origin}/${path}` for a non-empty page and the bare `${origin}` for the repo root, so the root emits `https://host/history/<sha>/` (no doubled slash). The same empty-path handling applies to a root commit-folder container's `memento:original` (see [History routes](#history-routes-ldp-navigable-commit-history)).
   
   The triples are omitted entirely when `listCommitsForPath({ perPage: 1 })` returns no commits for the page (defensive: the listing then matches today's LDP-only output byte-for-byte). One extra GitHub API call is made per `/:page*/` GET to fetch the latest commit. These triples mirror the inverse direction served by commit-folder containers (see [History routes](#history-routes-ldp-navigable-commit-history)).
5. Set `Content-Type: text/turtle; charset=utf-8` and the public edge-cache headers (`Netlify-CDN-Cache-Control: public, durable, max-age=60, stale-while-revalidate=86400`; see [Caching and WAC-Allow](#caching-and-wac-allow)). Add `Vary: Accept` (content negotiation) and, when the caller sent one, `Vary: If-None-Match`. 5xx is surfaced as `GitHubFetchError` → 502; 4xx surfaces as `GitHubApiError` → 502.

### Draft GET `/:page*/history/draft/:doc` and `/:page*/history/draft/`

Same proxy / listing semantics as the public route, but reads `${page}-draft` (the per-page branch) and falls back to `GITHUB_REF` on a 404. Auth is optional and only affects the `WAC-Allow` response header. The container path is derived from the URL pathname: `/:page*/history/draft/` strips the `/history/draft/` suffix and uses the remaining prefix, while a no-page-prefix subdirectory (`/history/draft/<sub>/`) uses `<sub>` as the path on the literal `draft` branch (container URI `/` for the root, `/<sub>/` for the subdirectory so children serialize relative to the request URL).

1. Load env; resolve `path`; reject 400 on unsafe path.
2. If the request carries both `Authorization` and `DPoP` headers, verify the DPoP token and resolve the effective WAC rules for that WebID. Anonymous reads (no headers, or one header missing) are not rejected — reads are public, so auth only affects the `WAC-Allow` write capability advertised on this route.
3. Fetch from `${page}-draft` (file via `fetchFileFromGitHub`; container via `listDirectoryFromGitHub`), forwarding `If-None-Match`. On a 404 (per-page branch missing or never edited), transparently re-fetch from `GITHUB_REF`. The fallback's `ETag`, `Cache-Control`, and `Vary: If-None-Match` are forwarded unchanged — git blob SHAs are content-addressed, so the same content on `main` and a freshly-created `${page}-draft` has the same SHA, and a `PUT` with `If-Match: "<etag>"` against the draft branch will be accepted. If the fallback also 404s, the caller sees 404 with `WAC-Allow`. 5xx is not retried.
4. Build `WAC-Allow` from the effective policy: `public` is the modes granted to `foaf:Agent`, and `user` is the requesting agent's modes unioned with the public modes (public access implies user access). For an unauthenticated request the agent's modes are the public modes, so `user` equals `public`. Emitted on every response (200, 304, 404, fallback).
5. Advertise editing capability via Solid-spec-compliant headers (mirrors CommunitySolidServer's behavior): `Allow: GET, PUT, OPTIONS`, `Accept-Put: */*`, `Accept-Patch: text/n3`. The advertised methods apply to **all** draft GET responses (200/304/404 and the fallback case) — `Accept-Patch: text/n3` is advertised even for non-RDF content-types so clients like `rdflib.js` recognize the resource as editable and route PATCH requests accordingly; the handler then enforces the `.ttl`-only constraint on the actual PATCH.
6. On 200, container bodies are serialized as Turtle `ldp:Container, ldp:BasicContainer` (same serializer as the public route) with `Content-Type: text/turtle; charset=utf-8`. Add `Vary: If-None-Match` whenever the caller sent `If-None-Match`.
7. Return the body with the upstream status (304 short-circuits to an empty body).
8. **Read-only directory-index for HTML clients** — same `Accept`-header rule as the public route, but when `<page>/index.html` is found on `${page}-draft` it is served read-only: `WAC-Allow: user="read", public="read"` is hard-coded (regardless of `authResult`), and the `Allow`/`Accept-Put`/`Accept-Patch` headers are omitted so clients don't see a write capability advertised. `Cache-Control: private, no-store` and `Netlify-CDN-Cache-Control: no-store` are still emitted because the underlying resource is on a working branch. A 404 on the index lookup falls through to the existing draft Turtle listing (with the normal draft headers).

### Draft PUT `/:page*/history/draft/:doc`

Solid-OIDC-authenticated commit to `${page}-draft`.

1. Verify the DPoP token via `verifyDpopToken` (`Authorization`+`DPoP` bound to `PUT`+`req.url`); reject 401 if headers are missing, 403 if the WebID lacks `write` on the target (and `append`/`write` on the container when creating it) per WAC.
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

**Supported patch shape** — the minimum ground-triples subset of [Solid Protocol §5.3.1](https://solidproject.org/TR/protocol#modifying-resources-using-n3-patches). Insert and delete triples are both supported when they contain only ground triples (NamedNode subjects/predicates; NamedNode or Literal objects).

```turtle
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix ex: <http://example.org/>.

_:patch
      solid:inserts {
        ex:alice ex:knows ex:bob .
      };
   a solid:InsertDeletePatch .
```

A delete example:

```turtle
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix ex: <http://example.org/>.

_:patch
      solid:deletes {
        ex:alice ex:knows ex:bob .
      };
   a solid:InsertDeletePatch .
```

Requirements enforced by the handler:

- Exactly **one** resource of type `solid:InsertDeletePatch` in the patch document.
- At least one of `solid:inserts` or `solid:deletes` must be present and contain at least one triple.
- `solid:where` predicate present ⇒ the formula must be empty. Solved conditions / variable bindings are **not** supported.
- All triples inside `solid:inserts` and `solid:deletes` must be **ground**: subject and predicate are `NamedNode`s; object is a `NamedNode` or `Literal`. No blank nodes, no variables.
- Every `solid:deletes` triple must already be present in the target document; if any is missing → 409 (per Solid spec §5.3.1: "the dataset does not contain all of these triples"). Deletions are applied before insertions.

Flow:

1. Verify the DPoP token via `verifyDpopToken` (`Authorization`+`DPoP` bound to `PATCH`+`req.url`); reject 401/403 unless WAC grants `write` on the target (or `append` for insert-only edits).
2. Resolve `path = ${page}/${doc}`; reject 400 on unsafe path; reject 405 if the route isn't a draft URL.
3. Validate that `doc` ends in `.ttl` (case-insensitive). Anything else → 422 "PATCH is only supported on .ttl paths". Note: the GET handler still advertises `Accept-Patch: text/n3` for non-`.ttl` draft URLs so capability discovery is consistent, but the PATCH handler enforces this server-side.
4. Validate `Content-Type: text/n3` (parameters ignored). Anything else → 415.
5. Parse `If-Match` if present (strip weak prefix `W/` and surrounding quotes).
6. Fetch the existing file from `${page}-draft` via `fetchFileFromGitHub`. A 404 means "create from empty"; any other upstream status passes through.
7. Hand `body` + `existing` to `applyInsertDeleteTurtlePatch` in `src/patch.ts` (see below). Validation failures throw `PatchValidationError` → 422 with the message; conflict (missing delete target) throws `PatchConflictError` → 409.
8. If `applyInsertDeleteTurtlePatch` reports `changed: false` — the inserts were all already present and/or a delete+insert cancelled out, so the resulting RDF graph equals the existing one — **skip the write entirely**. GitHub's Contents API would otherwise create an empty commit for byte-identical content. `If-Match` is still honoured (current blob SHA mismatch → 412), then the router returns 200 with `{commit: null, url: null, branch, path, etag, changed: false}` and `ETag: "<blob sha>"`.
9. Otherwise commit the merged turtle to `${page}-draft` via `commitFileOnBranch` with the same `If-Match` handling as PUT. On failure: `GitHubApiError` with status 409 or 422 → 412; other `GitHubApiError` → its status; `GitHubFetchError` / anything else → 502.
10. Return 200 with `{commit, url, branch, path, etag}` and `ETag: "<contentSha>"`.

#### `src/patch.ts`

A single function:

```ts
applyInsertDeleteTurtlePatch({ body, existing }: {
  body: Uint8Array         // raw PATCH body, expected to be text/n3
  existing: Uint8Array | null  // null if the file does not exist yet
}): Promise<{ content: string; contentType: 'text/turtle; charset=utf-8'; changed: boolean }>
```

Behavior: parses `body` as N3 (so formulae are preserved as `BlankNode`-rooted sub-graphs), locates the single `solid:InsertDeletePatch` resource, gathers the ground triples inside its `solid:inserts` and `solid:deletes` formulae, validates the constraints listed above, then parses `existing` (if present) as Turtle, removes every delete triple (after verifying each is present — otherwise `PatchConflictError`), adds the insert triples, and serializes the resulting graph back to Turtle. `changed` reports whether the resulting RDF graph differs from `existing` (graph-level, so Writer prefix/formatting churn alone is not a change). Throws `PatchValidationError` (status 422) on any validation failure; throws `PatchConflictError` (status 409) when a delete triple is not present in the document. The router maps each error class to its status code and skips the commit when `changed` is `false`.

#### Limitations

The router implements the **minimum ground-triples subset only**. The following Solid-spec features are **not** supported and return 422 (unless noted otherwise):

- `solid:where` with variable bindings (the BGP solver / variable-substitution machinery from `solidproject/conformance-test-harness` is out of scope here)
- Blank-node generation in `solid:inserts` or `solid:deletes`
- Variables in `solid:inserts` or `solid:deletes`
- Multi-patch documents (`solid:Patch` resources other than the single `solid:InsertDeletePatch`)
- Named-graph patches (`solid:from` / `solid:into`)
- `application/sparql-update` PATCH bodies (would require a SPARQL Update engine)
- PATCH on paths that don't end in `.ttl`
- PATCH on containers

Clients that need full N3 Patch semantics per [Solid Protocol §5.3.1](https://solidproject.org/TR/protocol#modifying-resources-using-n3-patches) should target a Solid server like [CommunitySolidServer](https://github.com/CommunitySolidServer/CommunitySolidServer) instead.

### Changelog POST `POST /:page*/history/changelog/`

Solid-OIDC-authenticated publish trigger for the changelog. Each POST produces exactly one main commit; pending edits (regular draft files and past-month changelog edits) ride along in the squash merge.

1. Verify the DPoP token bound to `POST`+`req.url`; reject 401/403 unless WAC grants `append` or `write`.
2. Validate Content-Type `text/turtle`; reject 415 otherwise.
3. Validate that the request path is `/<page>/history/changelog/` (trailing slash, root only); reject 405 otherwise.
4. Parse the body as Turtle. Locate the `as:Create` activity and its `as:object` blank node.
5. **Require** an `rdfs:label` literal on the activity blank node. Missing → 422 and abort. `rdfs:label` becomes the commit message and is **not** stored in the shard file.
6. Collect the remaining triples on the activity blank node — these are the **client payload** that will land in `<page>/.changelog/<year>/<month>.ttl` (the activity's identifier becomes `<#current>` in the file).
7. Look up the predecessor's short SHA via `listCommitsForPath({ perPage: 1 })` — the server determines `prov:used` from the commit history; the client does not supply it.
8. Read the current month shard from `${page}-draft` (so any pending month-PATCH edits on the draft branch are picked up). If the draft branch has no shard, fall back to `GITHUB_REF` (so a previously squash-merged shard is preserved). If the client payload is non-empty, substitute `_:b1` → `<#current>`, append the payload, and `commitFileOnBranch` the result to `${page}-draft`. If the payload is empty, skip the file write entirely.
9. `squashMergeBranch` merges `${page}-draft` → `GITHUB_REF` with the activity's `rdfs:label` as the commit message. The squash carries any other pending edits on the draft branch (regular file edits and past-month changelog edits). When the draft branch has no diff from base (e.g. empty payload + no other pending edits), GitHub returns 204 No Content; `squashMergeBranch` resolves to the current HEAD sha of `GITHUB_REF` and returns that as `{ commit, url, branch, etag, activity }` so the publish is reported as a successful no-op.
10. `deleteBranch` removes `${page}-draft` (the branch is recreated on the next edit).
11. Return 200 with `{commit, url, branch, etag, activity}`.

### Changelog month PATCH `PATCH /:page*/history/changelog/YYYY/MM`

Solid-OIDC-authenticated buffer for past-month changelog edits. Edits the per-month shard file at `<page>/.changelog/<year>/<month>.ttl` on `${page}-draft` (not main) — the edit sits in the draft branch until the next POST drains it via the squash merge.

The month URL has no extension; the on-disk file extension (`.ttl`) is authoritative and derived from the parsed month. `.ttl` and trailing-slash variants of the URL return 404. Same patch constraints as the draft PATCH: ground triples only, no `solid:where`, no blank nodes, no variables. The router validates the path is a month bucket (not root, not year) and the Content-Type is `text/n3`. As with the draft PATCH, a patch whose net effect leaves the RDF graph unchanged (`changed: false`) creates no commit and returns 200 with `{changed: false}` and the current `ETag`; `If-Match` is still enforced.

### Changelog GETs

GETs synthesize an LDP + ActivityStreams view of the page's commit history. The shard file holds only the client payload — `rdfs:label` and the server-managed triples (`rdf:type`, `prov:generated`, `prov:used`, `prov:endedAtTime`) are all synthesized from commit metadata at read time.

The changelog month is content-type-negotiable: today only Turtle is emitted, but the URL has no extension so future serializers (JSON-LD, NTriples, HTML) slot in via Accept-header negotiation without changing IRIs.

1. Load `GITHUB_REPO`/`GITHUB_TOKEN`/`GITHUB_REF`.
2. **Root** `/<page>/history/changelog/` — return the synthesized `as:OrderedCollection` with year sub-containers. `as:first`/`as:last` point to the first/last year pages; no `as:items` (items live in year pages). 301 redirect from the no-slash form.
3. **Year** `/<page>/history/changelog/YYYY/` — return the synthesized `as:OrderedCollectionPage` for that year. `as:partOf` the root; `as:prev`/`as:next` to sibling years; `as:items` lists month-page URIs (bare, no `.ttl`). Month children are typed `ldp:Resource` (not `ldp:Container`). 301 redirect from the no-slash form.
4. **Month** `/<page>/history/changelog/YYYY/MM` — the canonical month resource URL. The shard file is fetched from `<page>/.changelog/<year>/<month>.ttl` on `${page}-draft` first; on 404, fall back to `GITHUB_REF` (with `logTag: "fallback"`). This means any pending month-PATCH edits on the draft branch are visible immediately, before the next POST drains them. The response body is canonical — anonymous and authenticated callers receive byte-identical Turtle; only `WAC-Allow` varies per request. Enumerate commits via `listCommitsForPath` (filtered by date range) to get the SHAs, dates, and commit messages. For each commit in chronological order:
   - Look up the activity's client payload in the shard (subject is `<#current>`, which is resolved to `<#<latestShortSha>>` at read time — but other prior commits in the shard keep their `<#<shortSha>>` subject). Activities with no client payload simply have no triples in the file.
   - Add synthesized server-managed triples. Each commit is a local fragment of the month resource (`<#abc1234>`, not a fragment of the page URL). For example:

     ```turtle
     <#abc1234>
         a prov:Activity ;
         prov:generated <page_url>/history/abc1234 ;
         prov:used <page_url>/history/def5678 ;
         prov:endedAtTime "2024-03-15T10:30:00Z"^^xsd:dateTime ;
         rdfs:label "Initial save" ;
         ex:custom "foo" .
     ```

     `prov:used` is omitted for the very first commit ever. `rdfs:label` is the commit message (the file holds only the client payload — `ex:custom "foo"` in this example). `prov:generated` / `prov:used` point at the per-commit history folder (`<page_url>/history/<shortSha>`) so the page-state relationships are addressable.
5. Wrap with the LDP + AS envelope (`a as:OrderedCollectionPage`, `as:partOf`, inline `as:items`). The document is serialized with `baseIRI = <monthUrl>` so commit fragments serialize as `<#<shortSha>>`.
6. The `.ttl` URL form (`/YYYY/MM.ttl`) and the trailing-slash form (`/YYYY/MM/`) both return 404 — the month is a resource, not a container, and the on-disk file extension is authoritative.
7. Years/months outside `[REPO_START_YEAR, currentYear]` return 404.

**Drift policy:** main commits are the canonical source for server-managed triples. Force-push to `GITHUB_REF` and history rewrites are not supported; if they happen, GET will reflect the new commit state.

### History routes (LDP-navigable commit history)

The history tree under `/:page*/history/` is an LDP-navigable view of `${GITHUB_REPO}@${GITHUB_REF}`'s commit history affecting `<page>/*`. It is fully read-only and anonymous; mutations flow through the existing draft route.

#### URL matrix

| URL | Response | Backing API calls |
|---|---|---|
| `GET /:page/history/` | LDP `BasicContainer` listing years `[REPO_START_YEAR..currentYear]`, plus `<changelog/>` and `<draft/>` as siblings (both are always-listed virtual routes, not files) | **0** |
| `GET /:page/history/YYYY/` (in range) | LDP `BasicContainer` of `<MM>/` for months with commits | 1 (date-scoped `listCommitsForPath`) |
| `GET /:page/history/YYYY/` (out of range) | 404 | 0 |
| `GET /:page/history/YYYY/MM/` | LDP `BasicContainer` of `<shortSha>/` for commits in that month | 1 (date-scoped `listCommitsForPath`) |
| `GET /:page/history/YYYY/MM/<shortSha>/` | LDP `BasicContainer` listing immediate children of `<page>/` at that commit | 1 (`listDirectoryFromGitHub`, single-folder, no recursive subtree) |
| `GET /:page/history/<shortSha>/` | same as above (year/month prefix optional) | 1 |
| `GET /:page/history/<shortSha>/<doc*>` | file content at that commit | 1 (`fetchFileFromGitHub`) |
| `GET /:page/history/YYYY/MM/<shortSha>/<doc*>` | same as above (year/month prefix ignored) | 1 |

Container IRIs carry a trailing slash by convention (matches the Solid / LDP convention; CommunitySolidServer does the same). The no-slash form is always redirected to the slash form before any backing call:

| Request | Response |
|---|---|
| `GET /:page/history` (no slash) | 301 `Location: /:page/history/` |
| `GET /:page/history/YYYY` (no slash) | 301 `Location: /:page/history/YYYY/` |
| `GET /:page/history/YYYY/MM` (no slash) | 301 `Location: /:page/history/YYYY/MM/` |
| `GET /:page/history/<shortSha>` (no slash) | 301 `Location: /:page/history/<shortSha>/` |
| `GET /:page/history/<shortSha>/<doc*>` | 200 (no redirect — file, not container) |
| `GET /:page/history/changelog` (no slash) | 301 `Location: /:page/history/changelog/` |
| `GET /:page/history/changelog/YYYY` (no slash) | 301 `Location: /:page/history/changelog/YYYY/` |
| `GET /:page/history/changelog/YYYY/MM` | 200 (no redirect — month is a resource, not a container) |
| `GET /:page/history/changelog/YYYY/MM/` | 404 (month rejects the trailing-slash form; the month is a resource) |

The redirect fires before any GitHub API call, so a 301 is cheap (no upstream cost on a non-canonical request).

Commit-folder containers (`<shortSha>/`) carry two extra triples in Turtle form for provenance:

- `<http://www.w3.org/ns/prov#wasGeneratedBy>` — the corresponding `prov:Activity` in the changelog: `<pageUrl>/history/changelog/YYYY/MM#<shortSha>`. The year/month is derived from the commit's author date via an extra `GET /repos/:owner/:repo/commits/:ref` (GitHub resolves 7-char short SHAs natively). If the commit lookup fails, this triple is omitted.
- `<http://mementoweb.org/ns#original>` — the version-independent page root: `<pageUrl>/`. For a root commit folder (`/history/<shortSha>/`) `<pageUrl>` is the bare origin, so the object is `https://host/` (no doubled slash).

These are emitted unconditionally alongside `ldp:contains`, regardless of whether the container is empty.

Date-scoped `listCommitsForPath` calls cap at `perPage=100` (the GitHub API's first page). Year/month listings for pages with >100 commits affecting them in a given window are silently truncated — only the first 100 commits are reflected in `<MM>/` or `<shortSha>/` children.

Content negotiation: `Accept: text/turtle` (or absent) → `text/turtle; charset=utf-8`; `Accept: text/html` → `text/html; charset=utf-8`. The HTML form renders a `<ul>` of `<a href>` children, suitable for browser navigation.

#### SHA-robust addressing

The commit SHA in the URL is the source of truth. Year and month segments in the URL are bucket metadata used for LDP navigation; they are not used to resolve the commit. Concretely:

- `/foo/history/abc1234/foo.txt` and `/foo/history/2024/03/abc1234/foo.txt` both fetch `<page>/foo.txt` at commit `abc1234*`. The wrong year/month prefix is ignored.
- `/foo/history/draft` (no `:doc`) returns 404 — the draft route has its own path matcher and is unaffected by the history catch-all.
- SHA validity: 7–40 lowercase hex characters. SHAless URLs (e.g. `/foo/history/2026/`) are valid only as year/month container listings, not as file fetches.

### Web Access Control (WAC)

Authorization follows [WAC 1.0](https://solidproject.org/TR/wac), evaluated on every **write** and **control** request. Public reads are unenforced, so the public content routes never consult the policy — only the draft and changelog routes, which advertise write capability, resolve it. The policy is **not** stored in the GitHub repository: it lives in a [Netlify Blobs](https://docs.netlify.com/blobs/overview/) store (`ACL_STORE`, default `acl`) as a single authoritative JSON document. Only the wire-format `WAC-Allow` header keeps WAC/RDF semantics — the stored policy is plain JSON.

The policy store and the audit store are read with `consistency: "strong"`, so an ACL change is enforced on the very next request (the Blobs default is eventual, which can serve a stale policy for up to 60 seconds).

#### Policy document

A single blob, keyed `policy`, holds every scope and the deduplicated rulesets they resolve to. It **is** the source of truth (there is no separate authored form); recovery pairs the audit ledger with a periodic offsite export (see [Audit ledger](#audit-ledger)).

```jsonc
{
  "schema": 1,
  "rev": 42,
  "updatedAt": "2026-10-08T12:00:00Z",
  "updatedBy": "https://alice.example/profile#me",
  "scopes": {
    "":                { "self": "rs_root_self",  "default": "rs_root_def" },
    "/alice/":         { "self": "rs_alice_self", "default": "rs_alice_def" },
    "/alice/private/": { "self": "rs_priv_self",  "default": "rs_priv_def" }
  },
  "rulesets": {
    "rs_root_def":  [ { "subject": { "class": "public" }, "modes": ["read"] } ],
    "rs_alice_def": [ { "subject": { "type": "webid", "id": "https://alice.example/profile#me" }, "modes": ["read", "write", "control"] } ],
    "rs_priv_def":  [ { "subject": { "type": "webid", "id": "https://alice.example/profile#me" }, "modes": ["read"] } ]
  }
}
```

- `scopes` is kept sorted; a request path resolves to the **longest matching prefix**.
- Each scope names two rulesets: `self` (grants on the scope resource itself — WAC `acl:accessTo`) and `default` (grants inherited by descendants — WAC `acl:default`).
- `default` is pre-flattened: it already contains every ancestor's defaults, so evaluation never walks the hierarchy.
- A `subject` is one of `{ "class": "public" }`, `{ "class": "authenticated" }`, `{ "type": "webid", "id": … }`, `{ "group": … }`, or `{ "origin": … }`.
- Modes are `read`, `write`, `append`, and `control`; `append` is a subclass of `write` (a `write` grant satisfies an `append` requirement).
- Read modes are stored for completeness; enforcement currently covers `write`/`append`/`control` only, because public reads are unenforced.

Rulesets are content-addressed and shared, so a policy covering thousands of resources but only a handful of ACLs stays O(#ACLs) in size — the index is keyed by **scope**, not by resource.

#### Owner protection (loss of control)

`OWNER_WEBIDS` is an out-of-band escape hatch that mirrors CommunitySolidServer's [`OwnerPermissionReader`](https://github.com/CommunitySolidServer/CommunitySolidServer/blob/main/src/authorization/OwnerPermissionReader.ts) ("allows pod owners to always edit permissions on the data"). A WebID listed in `OWNER_WEBIDS` is always granted full modes (`read`, `write`, `append`, `control`) on every `.acl` resource, regardless of what the policy says, so an owner can never be locked out by a misconfigured ACL — they can always read and repair it. Like CSS, the override is scoped to ACL resources, not the data itself.

#### Authorization

1. `get(ACL_STORE, "policy", { consistency: "strong" })`.
2. Longest-prefix match the request path against `scopes`.
3. Use the matched scope's `self` when the request targets the scope itself, otherwise its `default`.
4. Grant when some rule matches both the subject and the required mode.

That is one blob read plus a scan over a single (small) ruleset, independent of how many resources fall under the scope. It runs only for writes and control requests; public `GET`s skip it entirely.

`PUT` requires `write` on the target and, when creating it, `append` (or `write`) on the containing container. `PATCH` requires `write`, or `append` for edits that only insert, and likewise `append`/`write` on the container when creating the resource. `POST` requires `append` or `write` on the container. ACL resources require `control`.

The same resolution produces `WAC-Allow` for the routes that advertise it (draft and changelog): `public` lists the modes granted to `foaf:Agent`, and `user` lists the requesting agent's modes unioned with the public modes (public access implies user access, matching CommunitySolidServer).

#### Policy edits (write path)

Policy edits arrive on the ACL resource routes — `PUT /<path>.acl` (replace) and `PATCH /<path>.acl` (N3 Patch), both gated on `control`. Each is a read-modify-write on the `policy` blob, guarded by Netlify Blobs' compare-and-swap so racing editors cannot drop each other:

1. `get` the document and its `etag`.
2. Apply the change, then recompute the edited scope and every descendant scope's flattened `default` (bounded by the number of scopes, not resources).
3. `setJSON(ACL_STORE, "policy", next, { onlyIfMatch: etag })`.
4. On conflict (`modified: false`), re-read, re-merge, and retry — the same optimistic-concurrency contract as the GitHub `If-Match` flow [above](#per-branch-concurrency--if-match-flow).
5. Append an audit event.

#### Audit ledger

Every edit appends an immutable event to `ACL_AUDIT_STORE` (default `acl-audit`) under a sortable key `events/<isoTimestamp>#<ulid>`, hash-chained so gaps or tampering are detectable:

```jsonc
{
  "ts": "2026-10-08T12:00:00Z",
  "actor": "https://alice.example/profile#me",
  "scope": "/alice/private/",
  "op": "grant",
  "before": "rs_prev",
  "after":  "rs_priv_self",
  "prevHash": "…",
  "hash": "…"
}
```

The ledger is the audit source of truth, **not** a backup: it shares the policy's provider, account, and region, captures only function-mediated edits, and Netlify Blobs has no versioning or restore — a store-wide loss or leaked credential takes both policy and ledger. Pair it with a periodic offsite export (a private GitHub repo fits well, since each backup is a commit with a human-readable diff) and treat that export as the disaster-recovery source. **Restore** by writing the most recent offsite snapshot back to the `policy` blob (`setJSON` with `onlyIfNew` on an empty store, or `onlyIfMatch` against the current `etag` to overwrite), then replaying any later audit events up to the target `rev` and verifying the hash chain from the snapshot's revision. `list({ prefix: "events/" })` enumerates history, and per-blob metadata (`rev`, `updatedAt`, `updatedBy`) renders an audit view without reading values.

#### ACL resource routes

An ACL resource is served under the WAC `acl` link relation and is gated by `control`:

| Resource | ACL resource URL |
|---|---|
| Root container `/` | `/.acl` |
| Container `/:page*/` | `/:page*/.acl` |
| Member `/:page*/:doc` | `/:page*/:doc.acl` |

- `GET` returns the ACL resource as `text/turtle` (RDF), serialized from the stored JSON policy — the representation the spec requires.
- `PUT` replaces the scope's authored grants; `PATCH` applies an N3 Patch (same ground-triples subset as the draft PATCH above).
- `GET` on a path whose scope has no authored grants returns `404` (WAC: no representation, so the path inherits from its nearest ancestor).
- Every response carries `Link: <{acl URL}>; rel="acl"`.

#### Caching and WAC-Allow

`WAC-Allow` is computed from the effective policy for the requesting agent and is emitted **only** on the routes that advertise write capability — the draft routes and the changelog root/month GETs. Because those responses are agent-dependent, they are `private, no-store` with `Vary: Authorization, DPoP` and are never shared-cached.

Public content reads are agent-independent and therefore edge-cacheable: the public file, container, and directory-index routes carry `Netlify-CDN-Cache-Control: public, durable, max-age=60, stale-while-revalidate=86400`, so a request inside the revalidation window is served stale while the edge refreshes in the background, and an edge miss is backed by Netlify's durable cache instead of a fresh GitHub round trip.

The invariant: **a response is edge-cacheable if and only if it is agent-independent.** Any response carrying `WAC-Allow` must be `no-store`; any cacheable response must not carry `WAC-Allow` and must not vary on `Authorization`/`DPoP`. A regression test enforces this.

### OPTIONS

204 with CORS allow-list as documented above (including `Access-Control-Allow-Credentials: true`). No auth, no upstream call.

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
│   ├── changelog.ts         # Changelog POST flow + GET synthesis helpers
│   ├── config.ts            # Env loading (ownerWebIds, aclStore, aclAuditStore, githubRepo, githubToken, githubRef)
│   ├── github.ts            # GitHub Contents API + refs helpers + commitFileOnBranch + listCommitsForPath + squashMergeBranch + deleteBranch
│   ├── history.ts           # parseHistoryPath: pure URL shape -> discriminated union
│   ├── ldp.ts               # LDP BasicContainer Turtle/HTML serializers
│   ├── patch.ts             # Minimal N3 InsertDelete patch (ground triples) parser/applier
│   └── wac/                 # WAC policy store, evaluator, and audit ledger
│       ├── policy.ts        # Authoritative JSON policy document: resolve + read-modify-write (CAS)
│       ├── evaluate.ts      # Longest-prefix scope resolution + subject/mode matching
│       ├── audit.ts         # Append-only, hash-chained ACL ledger + periodic snapshots
│       └── blobs.ts         # Netlify Blobs access (strong consistency, conditional writes)
├── tests/
│   ├── helpers/             # dev-server spawn (port 9999) + build-config setup
│   ├── unit/                # auth, build-config, changelog, config, github, history, ldp, patch, router
│   ├── integration/         # Router handler tests with mocked deps
│   └── e2e/                 # Tests against `netlify dev`
└── LICENSE
```

## Architecture

### Components and trust boundaries

- **Netlify function** (`netlify/functions/router/router.mts`): the only externally reachable surface; stateless across invocations.
  - Route table (`config.path`): `/`, `/:page*/:doc`, `/:page*/`, `/:page*/history/draft/:doc`, `/:page*/history/draft/`, `/:page*/history/:rest*`, `/:page*/history/changelog/`, `/:page*/history/changelog/:year/`, `/:page*/history/changelog/:year/:month`.
  - Methods (`config.method`): `POST, PATCH, PUT, GET, OPTIONS` with `preferStatic: true` — matching assets in the static `public/` are served first; everything else falls through to the function.
- **GitHub**: durable storage for file contents.
  - Public reads: `${GITHUB_REPO}@${GITHUB_REF}:${page}/${doc}` via `GET /repos/${repo}/contents/${path}?ref=${ref}` with `Accept: application/vnd.github.raw`.
  - Public container listings: `${GITHUB_REPO}@${GITHUB_REF}:${page}/` with `Accept: application/vnd.github+json`.
  - History routes: `GET /repos/${repo}/commits?sha=${branch}&path=${path}&since=...&until=...` (enumerate commits) and `GET /repos/${repo}/contents/${path}?ref=${shortSha}` (fetch a file at that commit).
  - Draft reads and writes target `${GITHUB_REPO}@${page}-draft`, which the function creates from `GITHUB_REF` on first PUT/PATCH/POST per page.
  - Changelog shards are stored at `${GITHUB_REPO}@${GITHUB_REF}:<page>/.changelog/<year>/<month>.ttl`. The first POST for a page creates `${page}-draft`, commits the new current-month shard, squash-merges it into `GITHUB_REF`, and deletes the draft branch.
  - Squash-merge: `POST /repos/${repo}/merges` with `{ base, head, commit_message, squash: true }`. Merge conflict (HTTP 409 from GitHub) is surfaced as 502.
- **Netlify Blobs**: the WAC policy and audit stores. The `policy` blob (`ACL_STORE`) is the authoritative, confidential access-control document; `ACL_AUDIT_STORE` is the append-only, hash-chained ledger. Blobs have no public URL — the function is the only gate — so ACLs never leave the confidential store. Policy reads use `consistency: "strong"`; policy writes use `onlyIfMatch` compare-and-swap.
- **OIDC issuer**: any issuer can sign DPoP tokens.
  - Every write and control request is authorized by WAC per the spec's method→mode mapping: `PUT` needs `write` on the resource and, when creating it, `append`/`write` on the container; `PATCH` needs `write`, or `append` for insert-only edits (plus `append`/`write` on the container when creating the resource); `POST` needs `append` or `write` on the container. Public reads are unenforced.
  - Draft and changelog GETs compute `WAC-Allow` from the effective policy; an unauthenticated request reports the public modes under both `user` and `public` (public access implies user access, matching CommunitySolidServer).
  - `OWNER_WEBIDS` seeds the root policy with `acl:Control`, `acl:Read`, and `acl:Write` at bootstrap.

### Repository layout

A typical repo backing this function looks like:

```
${GITHUB_REPO}/
├── main                              # GITHUB_REF (default branch)
│   ├── foo/bar.txt                   # served by GET /foo/bar
│   ├── foo/.changelog/              # changelog shards (per-month)
│   │   └── 2024/03.ttl               # client-supplied triples for the 2024/03 bucket
│   └── alice/profile.ttl            # served by GET /alice/profile.ttl
└── foo-draft                         # short-lived: created on edit, deleted after the next POST's squash
    ├── bar.txt                       # pending file edit
    └── .changelog/2024/03.ttl        # pending changelog edits (past-month PATCHes)
```

Each per-page `${page}-draft` branch is created on first PUT/PATCH/POST and lives until the next POST's squash merge deletes it. Public reads and draft reads are isolated to their respective branches; the changelog POST is the only thing that promotes a draft to `GITHUB_REF`, and it does so via a single squash merge. Promoting other draft edits (regular file edits) to `GITHUB_REF` remains a separate GitHub-side PR/merge operation.

The WAC policy is deliberately **absent** from this tree: it lives only in Netlify Blobs, so ACLs are never committed to `GITHUB_REPO` and never served by a public route.

```
ACL_STORE (Netlify Blobs)                # confidential; never in GITHUB_REPO
└── policy                               # single authoritative JSON policy document

ACL_AUDIT_STORE (Netlify Blobs)
└── events/<isoTimestamp>#<ulid>         # append-only, hash-chained policy edits

<offsite backup>                         # periodic export (e.g. private GitHub repo)
└── policy/<rev>.json                    # full snapshots for disaster recovery
```
