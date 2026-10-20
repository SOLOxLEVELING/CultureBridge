import { handleKitRequest } from "@/lib/api";

// Vercel Hobby allows up to 60s; 30s accommodates agent (12s) +
// fallback (~10s) + verification + response overhead.
// Must be verified in the Vercel dashboard for the deployed plan.
export const maxDuration = 30;

function getClientId(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return "local";
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      {
        status: "error",
        output: null,
        error: { code: "invalid_request", message: "Invalid JSON body." },
        meta: {
          runId: "",
          city: "",
          anchorCount: 0,
          mode: "agent",
          cached: false,
          durationMs: 0,
        },
      },
      { status: 400 },
    );
  }

  const clientId = getClientId(request);
  const { response, httpStatus } = await handleKitRequest(body, clientId);

  return Response.json(response, { status: httpStatus });
}
