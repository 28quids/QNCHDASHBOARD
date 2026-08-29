/**
 * What the dashboard shows instead of numbers while the financial policy is unapproved.
 *
 * Deliberately not an empty state or a set of zeroes. Until costs are approved the engine has
 * no COGS, so every contribution line would equal revenue — a page of confident, wrong profit
 * figures. Naming the outstanding decisions is the useful thing to show.
 */

export function PolicyGate({ missing }: { missing: readonly string[] }) {
  return (
    <>
      <p className="eyebrow">QNCH · CONTROL CENTRE</p>
      <h1 className="title-sm">Not yet reporting</h1>

      <div className="banner">
        <h3>Financial policy is not approved</h3>
        <p className="muted">
          No profit figures are shown while this is outstanding. The engine has no approved
          costs, so every contribution line would simply equal revenue.
        </p>
      </div>

      <section className="panel">
        <h2>Outstanding</h2>
        <ol className="setup">
          {missing.map((item, index) => (
            <li key={item}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {item}
            </li>
          ))}
        </ol>
        <p className="muted small" style={{ marginTop: "1.5rem" }}>
          Decisions are listed in <code>docs/financial-policy-decision-register.md</code>. Once
          agreed, record them with <code>npm run seed:policy</code>, then run{" "}
          <code>npm run calculate</code>.
        </p>
      </section>
    </>
  );
}
