/**
 * A plain sample "customer website" with the widget embedded exactly as a customer would,
 * for previewing the live agent. Served from localhost, which is allowed by default.
 */
export default async function PreviewPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const apiUrl = process.env.PUBLIC_API_URL ?? process.env.API_URL ?? "http://localhost:4000";
  return (
    <main
      style={{
        fontFamily: "Georgia, serif",
        maxWidth: 720,
        margin: "0 auto",
        padding: "48px 24px",
        color: "#222",
        background: "#fff",
        minHeight: "100vh",
      }}
    >
      <p style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: "#888" }}>Widget preview</p>
      <h1 style={{ fontSize: 36, margin: "8px 0 16px" }}>Acme Outdoor Supply</h1>
      <p style={{ lineHeight: 1.7 }}>
        This page stands in for your website. The chat bubble in the corner is your published AgentFlow agent, loaded
        with the same one-line script tag you paste on your own site. The page&apos;s own styles (like this serif font)
        do not leak into the widget.
      </p>
      <script src={`${apiUrl}/widget.js`} data-flow={key} async />
    </main>
  );
}
