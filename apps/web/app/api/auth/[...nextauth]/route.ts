// Auth.js endpoints. The proxy only lets /api/auth/* through on the auth host.
import { NextRequest } from "next/server";
import { handlers } from "@il/auth";
import { protocol } from "@/lib/hosts.ts";

/**
 * Next.js hands route handlers a URL built from the server's own listen address
 * (e.g. http://localhost:3000), and Auth.js builds its callback and magic-link
 * URLs from it. Restore the public origin from the Host header first.
 */
function withPublicUrl(request: NextRequest): NextRequest {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host) {
    url.protocol = `${protocol()}:`;
    url.host = host;
  }
  return new NextRequest(url, request);
}

export const GET = (request: NextRequest) => handlers.GET(withPublicUrl(request));
export const POST = (request: NextRequest) => handlers.POST(withPublicUrl(request));
