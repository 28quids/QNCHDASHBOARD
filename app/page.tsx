const setupItems = [
  "Approve financial-policy decisions",
  "Apply the Supabase foundation migration",
  "Connect Shopify and complete a reconciled backfill",
  "Add advertising and Xero connectors",
];

export default function Home() {
  return (
    <main>
      <p className="eyebrow">QNCH · BUSINESS INTELLIGENCE</p>
      <h1>Control Centre</h1>
      <p className="lead">
        The financial engine foundation is in place. Live business metrics will appear after
        the approved data model, financial policy, and first reconciled sync are configured.
      </p>
      <section aria-labelledby="setup-heading">
        <h2 id="setup-heading">Implementation status</h2>
        <ol>
          {setupItems.map((item, index) => (
            <li key={item}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {item}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
