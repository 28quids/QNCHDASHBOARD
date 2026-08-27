"use client";

import { use, useActionState } from "react";
import { signIn, type SignInState } from "./actions";

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = use(searchParams);
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, {});

  return (
    <main className="narrow">
      <p className="eyebrow">QNCH · CONTROL CENTRE</p>
      <h1 className="title-sm">Sign in</h1>

      {params.error === "no-access" ? (
        <p role="alert" className="status-amber">
          That account signed in successfully but is not a member of the QNCH organisation.
        </p>
      ) : null}

      <form action={action} className="stack">
        <input type="hidden" name="next" value={params.next ?? "/"} />
        <label>
          <span>Email</span>
          <input type="email" name="email" autoComplete="username" required autoFocus />
        </label>
        <label>
          <span>Password</span>
          <input type="password" name="password" autoComplete="current-password" required />
        </label>
        {state.error ? (
          <p role="alert" className="status-red">
            {state.error}
          </p>
        ) : null}
        <button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="muted small">
        Access is granted per user against the QNCH organisation. Run{" "}
        <code>npm run grant:access</code> to add an account.
      </p>
    </main>
  );
}
