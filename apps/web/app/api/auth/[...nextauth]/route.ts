// Auth.js endpoints. The proxy only lets /api/auth/* through on the auth host.
import { handlers } from "@il/auth";

export const { GET, POST } = handlers;
