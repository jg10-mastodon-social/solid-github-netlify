import type { Config, Context } from "@netlify/functions";
import { verifyDpopToken } from "../../../src/auth.js";
import { loadConfig } from "../../../src/config.js";

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
    return new Response(
      `${req.method} ${context.params.page} / ${context.params.doc}`,
      { headers: corsHeaders },
    );
  } catch (error) {
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
  const config = loadConfig();
  const authHeader = req.headers.get("authorization") ?? undefined;
  const dpopHeader = req.headers.get("dpop") ?? undefined;

  const authResult = await verifyDpopToken(
    authHeader,
    dpopHeader,
    req.url,
    "PUT",
    config.writeWebIds,
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

const getCorsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin ?? "*",
  "Access-Control-Allow-Methods": "PUT, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature",
  Vary: "Origin",
});

export const config: Config = {
  path: ["/:page*/:doc"],
  method: ["PUT", "GET", "OPTIONS"],
  preferStatic: true,
};