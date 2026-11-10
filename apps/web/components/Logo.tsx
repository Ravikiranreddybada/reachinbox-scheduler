const GLYPHS = {
  O: ['11111', '10001', '10001', '10001', '10001', '10001', '11111'],
  N: ['10001', '11001', '10101', '10101', '10011', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
} as const;

/** Pixel-style "ONB" wordmark, drawn as SVG so it stays sharp at any size. */
export function Logo({ className = 'logo' }: { className?: string }) {
  const cells: React.ReactNode[] = [];
  (['O', 'N', 'B'] as const).forEach((letter, index) => {
    GLYPHS[letter].forEach((row, y) =>
      [...row].forEach((bit, x) => {
        if (bit === '1') {
          cells.push(
            <rect key={`${letter}${x}${y}`} x={index * 6 + x} y={y} width="1.02" height="1.02" />,
          );
        }
      }),
    );
  });
  return (
    <svg
      className={className}
      viewBox="0 0 17 7"
      role="img"
      aria-label="ONB"
      fill="currentColor"
      shapeRendering="crispEdges"
      style={{ aspectRatio: '17 / 7' }}
    >
      {cells}
    </svg>
  );
}
