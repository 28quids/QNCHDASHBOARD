import { requireSession } from "@/lib/auth/current-user";
import { Nav } from "../components/nav";
import { signOut } from "../login/actions";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <>
      <header className="topbar">
        <div className="brand">
          QNCH <span>·</span> Control Centre
        </div>
        <Nav />
        <form action={signOut}>
          <span className="muted small" style={{ marginRight: "0.75rem" }}>
            {session.user.email}
          </span>
          <button type="submit" className="link">
            Sign out
          </button>
        </form>
      </header>
      <main className="wide">{children}</main>
    </>
  );
}
