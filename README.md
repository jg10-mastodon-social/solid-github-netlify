# solid-github-netlify

![No maintenance intended](https://img.shields.io/badge/no_maintenance_intended-orange) ![Code quality: TDD vibe coded](https://img.shields.io/badge/code_quality-TDD_vibe_coded-orange)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/jg10-mastodon-social/solid-github-netlify#WRITE_WEBIDS=&GITHUB_REPO=octocat/hello-world&GITHUB_REF=HEAD)

Solid-protocol-compatible read/write proxy backed by a GitHub repository. Public reads from `${GITHUB_REPO}@${GITHUB_REF}`; writes go to per-page `${page}-draft` branches via Solid-OIDC-authenticated PUT.

- **Public GET** `GET /:page*/:doc` — unauthenticated. Proxies `${GITHUB_REPO}@${GITHUB_REF}:${page}/${doc}` via the GitHub Contents `application/vnd.github.raw` media type. Forwards `Content-Type` (inferred from the file extension via `mime-types`), `ETag`, and `Cache-Control`; honors `If-None-Match` (returns 304) and emits `Vary: If-None-Match` whenever the client sent one.
- **Draft GET** `GET /:page*/history/draft/:doc` — same proxy but reads `${page}-draft`. If `Authorization`+`DPoP` headers are present, runs `verifyDpopToken` against `WRITE_WEBIDS` and sets a `WAC-Allow` header reflecting auth state: `user="read write", public="read"` for an authenticated allowlisted WebID, `user="read", public="read"` otherwise. **Missing headers are not an error** — anonymous reads are allowed; the auth check only elevates `WAC-Allow`.
- **Draft PUT** `PUT /:page*/history/draft/:doc` — Solid-OIDC-authenticated against `WRITE_WEBIDS`. Creates the `${page}-draft` branch from `GITHUB_REF` if missing, then commits the file. Honors `If-Match` (sha precondition → 412 on mismatch) and `If-None-Match: *` (create-only → 412 if the path already exists on the branch). The two are mutually exclusive — sending both returns 400.
- **CORS** `OPTIONS` — 204 with allow-list `PUT, GET, OPTIONS`; allows headers `Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature, If-None-Match, If-Match`; exposes `ETag, Cache-Control, WAC-Allow`; echoes `Origin` (falls back to `*`); `Vary: Origin`.
- **Path safety** — every path goes through `isPathSafe` (no leading `/`, no empty/`./`..`/NUL segments); unsafe paths are rejected with 400.
- **Errors** — `GitHubFetchError` (network/5xx) and `GitHubApiError` (4xx) carry the upstream status; 5xx is surfaced as 502, 4xx passes through, 404 passes through.

## Prerequisites

- Node.js 18+
- [netlify-cli](https://docs.netlify.com/cli/get-started/) for local development (`npm install -g netlify-cli`)
- A GitHub [fine-grained personal access token](https://github.com/settings/personal-access-tokens) with `contents:write` on the target repository

## Setup

```bash
npm install
```

There is no build step — `netlify.toml` ships with `command = "# no build command"`. The function is deployed as-is from `netlify/functions/router/`.

Optional: copy `.env.example` to `.env` and fill in `WRITE_WEBIDS`, `GITHUB_REPO`, `GITHUB_TOKEN`, `GITHUB_REF` for `netlify dev`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WRITE_WEBIDS` | Yes | Comma-separated list of WebIDs allowed to write (PUT). Empty list → no PUTs allowed. |
| `GITHUB_REPO` | Yes | `owner/repo` form. |
| `GITHUB_TOKEN` | Yes | GitHub PAT with `contents:write` on `GITHUB_REPO`. |
| `GITHUB_REF` | No | Ref for public reads and the base for new draft branches (default `HEAD`, which resolves to the repo's default branch on each call). |

## How it works

Every request handled by the router function logs a single `[router] METHOD /path` entry line at the start (e.g. `[router] PUT /foo/history/draft/bar`). Auth failures additionally log `[auth] DENIED: <reason>` and `[auth] Token iat timestamp is N seconds ahead/behind server time` when the underlying verifier rejects on `iat` clock skew. Grepping for `[router]` or `[auth]` is the fastest way to follow a single request through the function.

### Public GET `/:page*/:doc`

Unauthenticated proxy of `${GITHUB_REPO}@${GITHUB_REF}:${page}/${doc}`.

1. Load `GITHUB_REPO`/`GITHUB_TOKEN`/`GITHUB_REF` from env.
2. Resolve `path = ${page}/${doc}` from `context.params`; reject 400 on unsafe path.
3. `fetchFileFromGitHub` against `https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}` with `Accept: application/vnd.github.raw`, forwarding the request's `If-None-Match`.
4. Read `Content-Type` (preferring the inferred MIME from the file extension), `ETag`, and `Cache-Control` from the upstream response.
5. Add `Vary: If-None-Match` whenever the caller sent an `If-None-Match` (so CDN caches don't collapse 200 and 304 responses).
6. Return the body with the upstream status; 304 short-circuits to an empty body. Upstream 404 passes through to the caller; 5xx is surfaced as `GitHubFetchError` → 502.

### Draft GET `/:page*/history/draft/:doc`

Same proxy as the public route but reads `${page}-draft`. Auth is optional and only affects the `WAC-Allow` response header.

1. Load `GITHUB_REPO`/`GITHUB_TOKEN`/`GITHUB_REF`.
2. Resolve `path = ${page}/${doc}`; reject 400 on unsafe path.
3. If the request carries both `Authorization` and `DPoP` headers, run `verifyDpopToken` against `WRITE_WEBIDS`:
   - **Debugging:** an auth failure logs `[router] GET ${pathname} auth failed: <message>` and, depending on the underlying verifier error, a `[auth] DENIED: …` line plus a clock-skew note if the failure was an `iat` check. The function returns 401/403 with the verifier's message; anonymous reads (no headers, or one header missing) are not rejected.
4. Fetch the file from `${page}-draft` (same `fetchFileFromGitHub` path as above, with `If-None-Match` forwarded).
5. If the upstream returns 404 (the per-page branch doesn't exist yet, or this file was never edited on the draft), transparently re-fetch from `GITHUB_REF` and use that result. The fallback's `ETag`, `Cache-Control`, and `Vary: If-None-Match` are forwarded unchanged — git blob SHAs are content-addressed, so the same content on `main` and on a freshly-created `${page}-draft` has the same SHA, and a `PUT` with `If-Match: "<etag>"` against the draft branch will be accepted. If the fallback also 404s, the caller sees 404 with `WAC-Allow`. 5xx is not retried.
6. Build `WAC-Allow`: `user="read write", public="read"` for an authenticated allowlisted WebID; `user="read", public="read"` for an unauthenticated/anonymous reader. The header is only emitted on draft reads.
7. Return the body with the upstream status (304 short-circuits as above).

### Draft PUT `/:page*/history/draft/:doc`

Solid-OIDC-authenticated commit to `${page}-draft`.

1. Load `WRITE_WEBIDS`; verify the DPoP token via `verifyDpopToken` (`Authorization`+`DPoP` bound to `PUT`+`req.url`), allow-listed against `WRITE_WEBIDS`; reject 401 if headers missing, 403 if the WebID isn't allowlisted. **Debugging:** a failure logs `[router] PUT ${pathname} auth failed: <message>`. Underlying verifier errors log `[auth] DENIED: <error>` and, on `iat` clock-skew, `[auth] Token iat timestamp is N seconds ahead/behind server time`.
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
│           └── router.mts   # GET/PUT router for /:page*/:doc and /:page*/history/draft/:doc
├── netlify.toml             # Build config + function routing
├── src/
│   ├── auth.ts              # DPoP token verification
│   ├── config.ts            # Env loading (writeWebIds, githubRepo, githubToken, githubRef)
│   └── github.ts            # GitHub Contents API + refs helpers + commitFileOnBranch
├── tests/
│   ├── helpers/             # dev-server spawn (port 9999)
│   ├── unit/                # auth, config, github, router
│   ├── integration/         # Router handler tests with mocked deps
│   └── e2e/                 # Tests against `netlify dev`
└── LICENSE
```

## Architecture

### Components and trust boundaries

- **Netlify function** (`netlify/functions/router/router.mts`): the only externally reachable surface. Stateless across invocations. Route table is declared in `netlify.toml`'s function `config.path` (`/:page*/:doc` and `/:page*/history/draft/:doc`); the function's exported `config.method` is `PUT, GET, OPTIONS` with `preferStatic: true`, so a matching asset in the static `public/` is served first and anything else falls through to the function.
- **GitHub**: durable storage for file contents. Public reads serve `${GITHUB_REPO}@${GITHUB_REF}:${page}/${doc}` via `GET /repos/${repo}/contents/${path}?ref=${ref}` with `Accept: application/vnd.github.raw`. Draft reads and all writes target `${GITHUB_REPO}@${page}-draft`, which the function creates from `GITHUB_REF` on first PUT per page.
- **OIDC issuer**: any issuer can sign DPoP tokens, but only tokens whose `payload.webid` is in `WRITE_WEBIDS` are accepted on PUT. On draft GET, the same allowlist gates the `WAC-Allow` upgrade — anonymous readers (no `Authorization`/`DPoP` headers) and readers with a non-allowlisted WebID both get `user="read", public="read"` (public read is always permitted); only an authenticated allowlisted WebID elevates to `user="read write", public="read"`.

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
