import type { Config, Context } from "@netlify/functions";
import { verifyDpopToken } from "../../../src/auth.js";
import { loadGithubConfig, loadWriteConfig } from "../../../src/config.js";
import { fetchFileFromGitHub, GitHubFetchError, isPathSafe } from "../../../src/github.js";

export default async (req: Request, context: Context) => {
  const corsHeaders = getCorsHeaders(req.headers.get("Origin"));
  const pathname = new URL(req.url).pathname;
  console.log(`[router] ${req.method} ${pathname}`);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method === "PUT") {
      return await handlePut(req, context, corsHeaders);
    }
    if (req.method === "GET") {
      return await handleGet(req, context, corsHeaders);
    }
    return new Response(
      `${req.method} ${context.params.page} / ${context.params.doc}`,
      { headers: corsHeaders },
    );
  } catch (error) {
    if (error instanceof GitHubFetchError) {
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
};

async function handlePut(
  req: Request,
  context: Context,
  corsHeaders: Record<string, string>,
): Promise<Response> {
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
    console.log(`[router] PUT ${new URL(req.url).pathname} auth failed: ${authResult.message}`);
    return new Response(authResult.message, {
      status: authResult.statusCode,
      headers: corsHeaders,
    });
  }

  return new Response(
    `${req.method} ${context.params.page} / ${context.params.doc}`,
    { headers: corsHeaders },
  );
}

async function handleGet(
  req: Request,
  context: Context,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const { githubRepo, githubToken, githubRef } = loadGithubConfig();
  const { page, doc } = context.params;
  const path = `${page}/${doc}`;

  if (!isPathSafe(path)) {
    return new Response("Unsafe path", {
      status: 400,
      headers: corsHeaders,
    });
  }

  try {
    const result = await fetchFileFromGitHub({
      repo: githubRepo,
      token: githubToken,
      ref: githubRef,
      path,
      ifNoneMatch: req.headers.get("if-none-match") ?? undefined
    });

    const headers: Record<string, string> = { ...corsHeaders };
    if (result.contentType) headers["Content-Type"] = result.contentType;
    if (result.etag) headers["ETag"] = result.etag;
    if (result.cacheControl) headers["Cache-Control"] = result.cacheControl;

    const body = result.status === 304 ? null : (result.body as BodyInit);
    return new Response(body, {
      status: result.status,
      headers
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
      headers: corsHeaders
    });
  }
}

const getCorsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin ?? "*",
  "Access-Control-Allow-Methods": "PUT, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature, If-None-Match",
  "Access-Control-Expose-Headers": "ETag, Cache-Control",
  Vary: "Origin",
});

export const config: Config = {
  path: ["/:page*/:doc"],
  method: ["PUT", "GET", "OPTIONS"],
  preferStatic: true,
};
