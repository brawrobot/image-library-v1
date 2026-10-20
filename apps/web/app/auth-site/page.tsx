import { auth } from "@il/auth";
import { requestPlatformHost } from "@/lib/platform.ts";

export const dynamic = "force-dynamic";

/** auth.<root>/ — central sign-in landing. */
export default async function AuthHome() {
  await requestPlatformHost("auth");
  const session = await auth();
  return (
    <main>
      <h1>Image Library sign-in</h1>
      <div className="card">
        {session?.user ? (
          <>
            <p>
              Signed in as <strong>{session.user.email}</strong>
            </p>
            <p>
              <a href="/api/auth/signout">Sign out</a>
            </p>
          </>
        ) : (
          <p>
            <a href="/api/auth/signin">Sign in</a>
          </p>
        )}
      </div>
    </main>
  );
}
