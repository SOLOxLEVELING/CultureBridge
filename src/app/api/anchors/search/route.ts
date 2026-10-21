import { handleAnchorSearch } from "@/lib/api";

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
        resolutionStatus: "not_found",
        query: "",
        requestedType: "",
        candidates: [],
        error: {
          code: "invalid_request",
          message: "Invalid JSON body.",
        },
      },
      { status: 400 },
    );
  }

  const clientId = getClientId(request);
  const { response, httpStatus } = await handleAnchorSearch(body, clientId);

  return Response.json(response, { status: httpStatus });
}
