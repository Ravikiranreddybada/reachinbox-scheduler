/** Renders search highlights as React text nodes: user content never becomes markup. */
export function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\u0002[^\u0003]*\u0003)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith('\u0002') ? (
          <mark key={index}>{part.slice(1, -1)}</mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}
