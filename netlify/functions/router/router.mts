import type { Config, Context } from "@netlify/functions";
import { type AuthResponse, verifyDpopToken } from "../../../src/auth.js";
import { loadGithubConfig, loadWriteConfig } from "../../../src/config.js";
import {
  commitFileOnBranch,
  fetchFileFromGitHub,
  getFileBlobSha,
  GitHubApiError,
  GitHubFetchError,
  isPathSafe,
  listDirectoryFromGitHub,
  parseIfMatch,
} from "../../../src/github.js";
import { applyInsertOnlyTurtlePatch, PatchValidationError } from "../../../src/patch.js";
import { serializeContainer, formatContainerHtml } from "../../../src/ldp.js";
import { parseHistoryPath, type HistoryPath } from "../../../src/history.js";
import {
  listCommitsForPath,
  type Commit,
  type ListCommitsForPathOptions,
} from "../../../src/github.js";
import { REPO_START_YEAR } from "./repo-start-year.generated.mjs";

const DRAFT_SUFFIX = "/history/draft/";

function buildWacAllow(
  authResult: AuthResponse | undefined,
  writeWebIds: string[],
): string {
  const userMode =
    authResult?.success && writeWebIds.includes(authResult.payload.webid)
      ? "read write"
      : "read";
  return `user="${userMode}", public="read"`;
}

function isShaMismatch(error: unknown): boolean {
  if (!(error instanceof GitHubApiError)) return false;
  if (error.status === 409) return true;
  if (error.status === 422) {
    const msg = error.message.toLowerCase();
    return msg.includes("sha") && (msg.includes("match") || msg.includes("invalid"));
  }
  return false;
}

export default async (req: Request, context: Context) => {
  const corsHeaders = getCorsHeaders(req.headers.get("Origin"));
  const pathname = new URL(req.url).pathname;
  console.log(`[router] ${req.method} ${pathname}`);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method === "PUT") {
      return await handlePut(req, context, corsHeaders, pathname);
    }
    if (req.method === "PATCH") {
      return await handlePatch(req, context, corsHeaders, pathname);
    }
    if (req.method === "GET") {
      return handleGet(req, context, corsHeaders, pathname);
    }
    return new Response(
      `${req.method} ${context.params.page} / ${context.params.doc}`,
      { headers: corsHeaders },
    );
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
};

function errorResponse(error: unknown, corsHeaders: Record<string, string>): Response {
  if (error instanceof GitHubApiError || error instanceof GitHubFetchError) {
    return new Response(error.message, {
      status: error.status,
      headers: corsHeaders,
    });
  }
  return new Response(String(error), {
    status: 500,
    headers: corsHeaders,
  });
}

function isDraftRequest(pathname: string): boolean {
  return pathname.includes(DRAFT_SUFFIX);
}

function isHistoryRequest(pathname: string, context: Context): boolean {
  if (typeof context.params.rest === "string") {
    return true;
  }
  return /^\/[^/]+\/history\/?$/.test(pathname);
}

async function handleHistoryGet(
  req: Request,
  context: Context,
  corsHeaders: Record<string, string>,
  pathname: string,
): Promise<Response> {
  const page = context.params.page ?? "";
  const rest = context.params.rest ?? "";

  const parsed = parseHistoryPath(rest);
  if (parsed === null) {
    return notFound(corsHeaders);
  }

  if (parsed.kind === "history_root") {
    return serveHistoryRoot(req, page, corsHeaders);
  }

  if (parsed.kind === "year") {
    return await serveYearContainer(
      req,
      page,
      parsed.year,
      corsHeaders,
    );
  }

  if (parsed.kind === "month") {
    return await serveMonthContainer(
      req,
      page,
      parsed.year,
      parsed.month,
      corsHeaders,
    );
  }

  if (parsed.kind === "commit_folder") {
    return await serveCommitFolder(
      req,
      page,
      parsed.shortSha,
      corsHeaders,
    );
  }

  if (parsed.kind === "commit_file") {
    return await serveCommitFile(
      req,
      page,
      parsed.shortSha,
      parsed.doc,
      corsHeaders,
    );
  }

  return notFound(corsHeaders);
}

function notFound(corsHeaders: Record<string, string>): Response {
  return new Response("Not Found", { status: 404, headers: corsHeaders });
}

function serveHistoryRoot(
  req: Request,
  page: string,
  corsHeaders: Record<string, string>,
): Response {
  const currentYear = new Date().getUTCFullYear();
  const startYear = REPO_START_YEAR;
  const yearEntries: { name: string; path: string; type: "dir"; sha: string }[] = [];
  for (let y = startYear; y <= currentYear; y++) {
    yearEntries.push({
      name: String(y),
      path: `${page}/history/${y}`,
      type: "dir",
      sha: ""
    });
  }

  return renderContainerResponse(
    req,
    `/${page}/history/`,
    `Contents of ${page}/history`,
    yearEntries,
    corsHeaders,
  );
}

function isInRange(year: number): boolean {
  const currentYear = new Date().getUTCFullYear();
  return year >= REPO_START_YEAR && year <= currentYear;
}

async function serveYearContainer(
  req: Request,
  page: string,
  year: number,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!isInRange(year)) {
    return notFound(corsHeaders);
  }
  const { githubRef } = loadGithubConfig();
  const commits = await listCommitsForPath({
    repo: pageRepo(page),
    token: githubToken(),
    branch: githubRef,
    path: page,
    since: `${year}-01-01T00:00:00Z`,
    until: `${year}-12-31T23:59:59Z`,
    perPage: 100
  });

  const monthsWithCommits = new Set<number>();
  for (const commit of commits) {
    const m = monthFromIso(commit.date);
    if (m !== null) monthsWithCommits.add(m);
  }

  const monthEntries = [...monthsWithCommits]
    .sort((a, b) => a - b)
    .map((m) => ({
      name: String(m).padStart(2, "0"),
      path: `${page}/history/${year}/${String(m).padStart(2, "0")}`,
      type: "dir" as const,
      sha: ""
    }));

  return renderContainerResponse(
    req,
    `/${page}/history/${year}/`,
    `Contents of ${page}/history/${year}`,
    monthEntries,
    corsHeaders,
  );
}

async function serveMonthContainer(
  req: Request,
  page: string,
  year: number,
  month: number,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!isInRange(year)) {
    return notFound(corsHeaders);
  }
  const lastDay = lastDayOfMonth(year, month);
  const { githubRef } = loadGithubConfig();
  const commits = await listCommitsForPath({
    repo: pageRepo(page),
    token: githubToken(),
    branch: githubRef,
    path: page,
    since: `${year}-${String(month).padStart(2, "0")}-01T00:00:00Z`,
    until: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}T23:59:59Z`,
    perPage: 100
  });

  const shortShas = commits
    .map((c) => c.sha.slice(0, 7))
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .sort();

  const entries = shortShas.map((s) => ({
    name: s,
    path: `${page}/history/${year}/${String(month).padStart(2, "0")}/${s}`,
    type: "dir" as const,
    sha: ""
  }));

  return renderContainerResponse(
    req,
    `/${page}/history/${year}/${String(month).padStart(2, "0")}/`,
    `Contents of ${page}/history/${year}/${String(month).padStart(2, "0")}`,
    entries,
    corsHeaders,
  );
}

function pageRepo(page: string): string {
  return loadGithubConfig().githubRepo;
}

function githubToken(): string {
  return loadGithubConfig().githubToken;
}

function monthFromIso(iso: string): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.getUTCMonth() + 1;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function renderContainerResponse(
  req: Request,
  containerUri: string,
  title: string,
  entries: { name: string; path: string; type: "dir" | "file" | string; sha: string }[],
  corsHeaders: Record<string, string>,
  cacheControl: string = "public, max-age=86400, stale-while-revalidate=259200",
): Response {
  const accept = req.headers.get("Accept") ?? "";
  const wantHtml = accept.includes("text/html") && !accept.includes("text/turtle");
  const body = wantHtml
    ? formatContainerHtml(containerUri, title, entries as any)
    : serializeContainer(containerUri, entries as any);
  const headers: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": wantHtml
      ? "text/html; charset=utf-8"
      : "text/turtle; charset=utf-8",
    "Cache-Control": cacheControl
  };
  return new Response(body, { status: 200, headers });
}

async function serveCommitFolder(
  req: Request,
  page: string,
  shortSha: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const { githubRepo, githubToken } = loadGithubConfig();
  const result = await listDirectoryFromGitHub({
    repo: githubRepo,
    token: githubToken,
    ref: shortSha,
    path: page
  });

  if (result.status === 404) {
    return notFound(corsHeaders);
  }

  return renderContainerResponse(
    req,
    `/${page}/`,
    `Contents of ${page}/history/${shortSha}`,
    result.entries,
    corsHeaders,
    "public, max-age=31536000, immutable",
  );
}

async function serveCommitFile(
  req: Request,
  page: string,
  shortSha: string,
  doc: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const { githubRepo, githubToken } = loadGithubConfig();
  const path = `${page}/${doc}`;
  if (!isPathSafe(path)) {
    return new Response("Unsafe path", {
      status: 400,
      headers: corsHeaders,
    });
  }
  const result = await fetchFileFromGitHub({
    repo: githubRepo,
    token: githubToken,
    ref: shortSha,
    path,
    ifNoneMatch: req.headers.get("if-none-match") ?? undefined
  });

  const headers: Record<string, string> = {
    ...corsHeaders,
    "Cache-Control": "public, max-age=31536000, immutable"
  };
  if (result.contentType) headers["Content-Type"] = result.contentType;
  if (result.etag) headers["ETag"] = result.etag;
  if (req.headers.get("if-none-match")) {
    headers["Vary"] = appendVary(headers["Vary"], "If-None-Match");
  }

  const body = result.status === 304 ? null : (result.body as BodyInit);
  return new Response(body, {
    status: result.status,
    headers
  });
}

function appendVary(existing: string | undefined, value: string): string {
  const parts = (existing ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.includes(value)) parts.push(value);
  return parts.join(", ");
}

async function handlePut(
  req: Request,
  context: Context,
  corsHeaders: Record<string, string>,
  pathname: string,
): Promise<Response> {
  if (!isDraftRequest(pathname)) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  if (pathname.endsWith("/")) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  const { writeWebIds } = loadWriteConfig();
  const authHeader = req.headers.get("authorization") ?? undefined;
  const dpopHeader = req.headers.get("dpop") ?? undefined;

  const authResult = await verifyDpopToken(
    authHeader,
    dpopHeader,
    req.url,
    "PUT",
    writeWebIds,
  );

  if (!authResult.success) {
    console.log(`[router] PUT ${pathname} auth failed: ${authResult.message}`);
    return new Response(authResult.message, {
      status: authResult.statusCode,
      headers: corsHeaders,
    });
  }

  const { page, doc } = context.params;
  const path = `${page}/${doc}`;

  if (!isPathSafe(path)) {
    return new Response("Unsafe path", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const ifMatchHeader = req.headers.get("if-match");
  const ifNoneMatchHeader = req.headers.get("if-none-match");
  const ifMatch = parseIfMatch(ifMatchHeader);
  const ifNoneMatchStar =
    typeof ifNoneMatchHeader === "string" && ifNoneMatchHeader.trim() === "*";

  if (ifMatch && ifNoneMatchStar) {
    return new Response("If-Match and If-None-Match: * are mutually exclusive", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const { githubRepo, githubToken, githubRef } = loadGithubConfig();
  const branch = `${page}-draft`;
  const body = await req.arrayBuffer();
  const content = Buffer.from(body).toString("base64");
  const message = `Update ${path} via solid-github-netlify`;

  if (ifNoneMatchStar) {
    const existingSha = await getFileBlobSha({
      repo: githubRepo,
      token: githubToken,
      ref: branch,
      path,
    }).catch(() => null);
    if (existingSha) {
      return new Response("Resource already exists", {
        status: 412,
        headers: corsHeaders,
      });
    }
  }

  try {
    const result = await commitFileOnBranch({
      repo: githubRepo,
      token: githubToken,
      baseRef: githubRef,
      branch,
      path,
      content,
      message,
      ...(ifMatch ? { ifMatch } : {}),
    });

    return new Response(
      JSON.stringify({
        commit: result.commitSha,
        url: result.htmlUrl,
        branch: result.branch,
        path,
        etag: result.contentSha,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          ETag: `"${result.contentSha}"`,
        },
      },
    );
  } catch (error) {
    if (isShaMismatch(error)) {
      return new Response("If-Match failed", {
        status: 412,
        headers: corsHeaders,
      });
    }
    if (error instanceof GitHubApiError) {
      return new Response(error.message, {
        status: error.status,
        headers: corsHeaders,
      });
    }
    const message =
      error instanceof Error ? error.message : String(error);
    return new Response(message, {
      status: 502,
      headers: corsHeaders,
    });
  }
}

async function handlePatch(
  req: Request,
  context: Context,
  corsHeaders: Record<string, string>,
  pathname: string,
): Promise<Response> {
  if (!isDraftRequest(pathname)) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  const { writeWebIds } = loadWriteConfig();
  const authHeader = req.headers.get("authorization") ?? undefined;
  const dpopHeader = req.headers.get("dpop") ?? undefined;

  const authResult = await verifyDpopToken(
    authHeader,
    dpopHeader,
    req.url,
    "PATCH",
    writeWebIds,
  );

  if (!authResult.success) {
    console.log(`[router] PATCH ${pathname} auth failed: ${authResult.message}`);
    return new Response(authResult.message, {
      status: authResult.statusCode,
      headers: corsHeaders,
    });
  }

  const { page, doc } = context.params;
  if (!doc) {
    return new Response("PATCH requires a document path", {
      status: 405,
      headers: corsHeaders,
    });
  }
  const path = `${page}/${doc}`;

  if (!isPathSafe(path)) {
    return new Response("Unsafe path", {
      status: 400,
      headers: corsHeaders,
    });
  }

  if (!doc.toLowerCase().endsWith(".ttl")) {
    return new Response("PATCH is only supported on .ttl paths", {
      status: 422,
      headers: corsHeaders,
    });
  }

  const contentTypeHeader = req.headers.get("content-type");
  const contentTypeBase = contentTypeHeader?.split(";")[0]?.trim().toLowerCase();
  if (contentTypeBase !== "text/n3") {
    return new Response("PATCH requires Content-Type: text/n3", {
      status: 415,
      headers: corsHeaders,
    });
  }

  const ifMatchHeader = req.headers.get("if-match");
  const ifMatch = parseIfMatch(ifMatchHeader);

  const { githubRepo, githubToken, githubRef } = loadGithubConfig();
  const branch = `${page}-draft`;

  const body = new Uint8Array(await req.arrayBuffer());

  let existing: Uint8Array | null = null;
  try {
    const cur = await fetchFileFromGitHub({
      repo: githubRepo,
      token: githubToken,
      ref: branch,
      path,
    });
    if (cur.status === 200) {
      existing = cur.body;
    } else if (cur.status !== 404) {
      return new Response(`Upstream returned ${cur.status}`, {
        status: cur.status,
        headers: corsHeaders,
      });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return new Response(message, {
      status: 502,
      headers: corsHeaders,
    });
  }

  let applied: { content: string; contentType: "text/turtle; charset=utf-8" };
  try {
    applied = await applyInsertOnlyTurtlePatch({ body, existing });
  } catch (e) {
    if (e instanceof PatchValidationError) {
      return new Response(e.message, {
        status: 422,
        headers: corsHeaders,
      });
    }
    throw e;
  }

  const content = Buffer.from(applied.content, "utf-8").toString("base64");
  const message = `PATCH ${path} via solid-github-netlify`;

  try {
    const result = await commitFileOnBranch({
      repo: githubRepo,
      token: githubToken,
      baseRef: githubRef,
      branch,
      path,
      content,
      message,
      ...(ifMatch ? { ifMatch } : {}),
    });

    return new Response(
      JSON.stringify({
        commit: result.commitSha,
        url: result.htmlUrl,
        branch: result.branch,
        path,
        etag: result.contentSha,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          ETag: `"${result.contentSha}"`,
        },
      },
    );
  } catch (error) {
    if (isShaMismatch(error)) {
      return new Response("If-Match failed", {
        status: 412,
        headers: corsHeaders,
      });
    }
    if (error instanceof GitHubApiError) {
      return new Response(error.message, {
        status: error.status,
        headers: corsHeaders,
      });
    }
    const message =
      error instanceof Error ? error.message : String(error);
    return new Response(message, {
      status: 502,
      headers: corsHeaders,
    });
  }
}

async function handleGet(
  req: Request,
  context: Context,
  corsHeaders: Record<string, string>,
  pathname: string,
): Promise<Response> {
  if (isHistoryRequest(pathname, context)) {
    return await handleHistoryGet(req, context, corsHeaders, pathname);
  }
  const { githubRepo, githubToken, githubRef } = loadGithubConfig();
  const isContainer = pathname === "/" || pathname.endsWith("/");
  const draft = isDraftRequest(pathname);

  let path: string;
  let ref: string;
  let containerUri: string;
  if (isContainer) {
    const stripped = pathname.replace(/\/+$/, "").replace(/^\/+/, "");
    if (draft) {
      const page = stripped.replace(/\/history\/draft$/, "");
      path = page;
      ref = `${page}-draft`;
      containerUri = `/${page}${page ? "/" : ""}`;
    } else {
      path = stripped;
      ref = githubRef;
      containerUri = pathname === "/" ? "/" : pathname;
    }
  } else {
    const { page, doc } = context.params;
    path = `${page}/${doc}`;
    ref = draft ? `${page}-draft` : githubRef;
    containerUri = "";
  }

  if (path !== "" && !isPathSafe(path)) {
    return new Response("Unsafe path", {
      status: 400,
      headers: corsHeaders,
    });
  }

  let authResult: AuthResponse | undefined;
  let writeWebIds: string[] = [];
  if (draft) {
    const authHeader = req.headers.get("authorization") ?? undefined;
    const dpopHeader = req.headers.get("dpop") ?? undefined;
    if (authHeader && dpopHeader) {
      writeWebIds = loadWriteConfig().writeWebIds;
      authResult = await verifyDpopToken(
        authHeader,
        dpopHeader,
        req.url,
        "GET",
        writeWebIds,
      );
    }
  }

  if (isContainer) {
    return await handleContainerGet({
      req,
      corsHeaders,
      pathname,
      path,
      ref,
      containerUri,
      githubRepo,
      githubToken,
      githubRef,
      draft,
      authResult,
      writeWebIds,
    });
  }

  return await handleFileGet({
    req,
    corsHeaders,
    pathname,
    path,
    ref,
    githubRepo,
    githubToken,
    githubRef,
    draft,
    authResult,
    writeWebIds,
  });
}

interface ContainerGetContext {
  req: Request;
  corsHeaders: Record<string, string>;
  pathname: string;
  path: string;
  ref: string;
  containerUri: string;
  githubRepo: string;
  githubToken: string;
  githubRef: string;
  draft: boolean;
  authResult: AuthResponse | undefined;
  writeWebIds: string[];
}

async function handleContainerGet(ctx: ContainerGetContext): Promise<Response> {
  try {
    let result = await listDirectoryFromGitHub({
      repo: ctx.githubRepo,
      token: ctx.githubToken,
      ref: ctx.ref,
      path: ctx.path,
    });

    if (ctx.draft && result.status === 404) {
      result = await listDirectoryFromGitHub({
        repo: ctx.githubRepo,
        token: ctx.githubToken,
        ref: ctx.githubRef,
        path: ctx.path,
        logTag: "fallback",
      });
    }

    if (result.status === 404) {
      const headers: Record<string, string> = { ...ctx.corsHeaders };
    if (ctx.draft) {
      headers["WAC-Allow"] = buildWacAllow(ctx.authResult, ctx.writeWebIds);
      headers["Allow"] = "GET, PUT, OPTIONS";
      headers["Accept-Put"] = "*/*";
      headers["Accept-Patch"] = "text/n3";
    }
      return new Response("Not Found", { status: 404, headers });
    }

    const turtle = serializeContainer(ctx.containerUri, result.entries);
    const headers: Record<string, string> = {
      ...ctx.corsHeaders,
      "Content-Type": "text/turtle; charset=utf-8",
    };
    if (ctx.req.headers.get("if-none-match")) {
      headers["Vary"] = appendVary(headers["Vary"], "If-None-Match");
    }
    if (ctx.draft) {
      headers["WAC-Allow"] = buildWacAllow(ctx.authResult, ctx.writeWebIds);
      headers["Allow"] = "GET, PUT, OPTIONS";
      headers["Accept-Put"] = "*/*";
      headers["Accept-Patch"] = "text/n3";
    }
    return new Response(turtle, { status: 200, headers });
  } catch (error) {
    const message =
      error instanceof GitHubFetchError || error instanceof GitHubApiError
        ? error.message
        : error instanceof Error
        ? error.message
        : String(error);
    return new Response(message, {
      status: 502,
      headers: ctx.corsHeaders,
    });
  }
}

interface FileGetContext {
  req: Request;
  corsHeaders: Record<string, string>;
  pathname: string;
  path: string;
  ref: string;
  githubRepo: string;
  githubToken: string;
  githubRef: string;
  draft: boolean;
  authResult: AuthResponse | undefined;
  writeWebIds: string[];
}

async function handleFileGet(ctx: FileGetContext): Promise<Response> {
  try {
    let result = await fetchFileFromGitHub({
      repo: ctx.githubRepo,
      token: ctx.githubToken,
      ref: ctx.ref,
      path: ctx.path,
      ifNoneMatch: ctx.req.headers.get("if-none-match") ?? undefined,
    });

    if (ctx.draft && result.status === 404) {
      result = await fetchFileFromGitHub({
        repo: ctx.githubRepo,
        token: ctx.githubToken,
        ref: ctx.githubRef,
        path: ctx.path,
        ifNoneMatch: ctx.req.headers.get("if-none-match") ?? undefined,
        logTag: "fallback",
      });
    }

    const headers: Record<string, string> = { ...ctx.corsHeaders };
    if (result.contentType) headers["Content-Type"] = result.contentType;
    if (result.etag) headers["ETag"] = result.etag;
    if (result.cacheControl) headers["Cache-Control"] = result.cacheControl;
    if (ctx.req.headers.get("if-none-match")) {
      headers["Vary"] = appendVary(headers["Vary"], "If-None-Match");
    }
    if (ctx.draft) {
      headers["WAC-Allow"] = buildWacAllow(ctx.authResult, ctx.writeWebIds);
      headers["Allow"] = "GET, PUT, OPTIONS";
      headers["Accept-Put"] = "*/*";
      headers["Accept-Patch"] = "text/n3";
    }

    const body = result.status === 304 ? null : (result.body as BodyInit);
    return new Response(body, {
      status: result.status,
      headers,
    });
  } catch (error) {
    const message =
      error instanceof GitHubFetchError
        ? error.message
        : error instanceof Error
        ? error.message
        : String(error);
    return new Response(message, {
      status: 502,
      headers: ctx.corsHeaders,
    });
  }
}

const getCorsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin ?? "*",
  "Access-Control-Allow-Methods": "PATCH, PUT, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature, If-None-Match, If-Match",
  "Access-Control-Expose-Headers":
    "ETag, Cache-Control, WAC-Allow, Allow, Accept-Put, Accept-Patch",
  Vary: "Origin",
});

export const config: Config = {
  path: [
    "/:page*/history/draft/",
    "/:page*/history/draft/:doc*",
    "/:page*/history/:rest*",
    "/:page*/",
    "/:page*/:doc",
    "/",
  ],
  method: ["PATCH", "PUT", "GET", "OPTIONS"],
  preferStatic: true,
};
