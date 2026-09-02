import type { Config, Context } from "@netlify/functions";
import { type AuthResponse, verifyDpopToken } from "../../../src/auth.js";
import { loadGithubConfig, loadWriteConfig } from "../../../src/config.js";
import {
  commitFileOnBranch,
  fetchFileFromGitHub,
  GitHubApiError,
  GitHubFetchError,
  isPathSafe,
} from "../../../src/github.js";

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
    if (req.method === "GET") {
      return await handleGet(req, context, corsHeaders, pathname);
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

  const { githubRepo, githubToken, githubRef } = loadGithubConfig();
  const branch = `${page}-draft`;
  const body = await req.arrayBuffer();
  const content = Buffer.from(body).toString("base64");
  const message = `Update ${path} via solid-github-netlify`;

  try {
    const result = await commitFileOnBranch({
      repo: githubRepo,
      token: githubToken,
      baseRef: githubRef,
      branch,
      path,
      content,
      message,
    });

    return new Response(
      JSON.stringify({
        commit: result.commitSha,
        url: result.htmlUrl,
        branch: result.branch,
        path,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
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
  const { githubRepo, githubToken, githubRef } = loadGithubConfig();
  const { page, doc } = context.params;
  const path = `${page}/${doc}`;
  const ref = isDraftRequest(pathname) ? `${page}-draft` : githubRef;
  const draft = isDraftRequest(pathname);

  if (!isPathSafe(path)) {
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

  try {
    const result = await fetchFileFromGitHub({
      repo: githubRepo,
      token: githubToken,
      ref,
      path,
      ifNoneMatch: req.headers.get("if-none-match") ?? undefined,
    });

    const headers: Record<string, string> = { ...corsHeaders };
    if (result.contentType) headers["Content-Type"] = result.contentType;
    if (result.etag) headers["ETag"] = result.etag;
    if (result.cacheControl) headers["Cache-Control"] = result.cacheControl;
    if (draft) {
      headers["WAC-Allow"] = buildWacAllow(authResult, writeWebIds);
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
      headers: corsHeaders,
    });
  }
}

const getCorsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin ?? "*",
  "Access-Control-Allow-Methods": "PUT, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature, If-None-Match",
  "Access-Control-Expose-Headers": "ETag, Cache-Control, WAC-Allow",
  Vary: "Origin",
});

export const config: Config = {
  path: ["/:page*/:doc", "/:page*/history/draft/:doc"],
  method: ["PUT", "GET", "OPTIONS"],
  preferStatic: true,
};
