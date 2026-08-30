import { Context } from "@netlify/functions";

export default (req: Request, context: Context) => {
  const corsHeaders = getCorsHeaders(req.headers.get("Origin"));
  console.log(`[router] ${req.method} ${new URL(req.url).pathname}`);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    return new Response(
      `${req.method} ${context.params.page} / ${context.params.doc}`,
      { headers: corsHeaders },
    );
  } catch (error) {
    return new Response(error.toString(), {
      status: 500,
      headers: corsHeaders,
    });
  }
};

const getCorsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin ?? "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, DPoP, Content-Type, Accept, Date, Digest, Signature",
  Vary: "Origin",
});

export const config: Config = {
  path: ["/:page*/:doc"],
  method: ["POST", "GET", "OPTIONS"],
  preferStatic: true,
};
