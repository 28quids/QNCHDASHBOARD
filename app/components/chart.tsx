/**
 * Charts as plain SVG, rendered on the server.
 *
 * These are trend indicators, not an interactive plotting library: the brief asks for charts
 * that show a trend rather than decorate the page, and every figure on these pages is also
 * given as a number. Rendering them server-side means no charting dependency and no client
 * JavaScript to read the dashboard.
 *
 * A series that is entirely zero is drawn flat on a zero baseline rather than auto-scaled,
 * so a quiet week does not look like a volatile one.
 */

export interface SeriesPoint {
  date: string;
  value: number;
}

interface ChartProps {
  series: readonly SeriesPoint[];
  /** Bars suit spend and revenue by day; a line suits a ratio such as MER. */
  variant?: "bars" | "line";
  height?: number;
  colour?: string;
  label?: string;
}

const WIDTH = 720;

export function TrendChart({
  series,
  variant = "bars",
  height = 140,
  colour = "var(--accent)",
  label,
}: ChartProps) {
  if (series.length === 0) {
    return <p className="muted small">No data in this period.</p>;
  }

  const values = series.map((point) => point.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  // A flat zero series would divide by zero; give it a nominal span so it draws on the baseline.
  const span = max - min || 1;

  const plotHeight = height - 18;
  const y = (value: number) => plotHeight - ((value - min) / span) * plotHeight;
  const x = (index: number) => (series.length === 1 ? WIDTH / 2 : (index / (series.length - 1)) * WIDTH);

  const zeroLine = y(0);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      className="chart"
      role="img"
      aria-label={label ?? "Trend over the selected period"}
      preserveAspectRatio="none"
    >
      {min < 0 ? (
        <line x1="0" x2={WIDTH} y1={zeroLine} y2={zeroLine} stroke="var(--line)" strokeWidth="1" />
      ) : null}

      {variant === "bars" ? (
        <Bars series={series} y={y} zeroLine={zeroLine} colour={colour} />
      ) : (
        <polyline
          fill="none"
          stroke={colour}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          points={series.map((point, index) => `${x(index)},${y(point.value)}`).join(" ")}
        />
      )}

      <text x="0" y={height - 4} className="chart-axis">
        {series[0].date}
      </text>
      <text x={WIDTH} y={height - 4} textAnchor="end" className="chart-axis">
        {series[series.length - 1].date}
      </text>
    </svg>
  );
}

function Bars({
  series,
  y,
  zeroLine,
  colour,
}: {
  series: readonly SeriesPoint[];
  y: (value: number) => number;
  zeroLine: number;
  colour: string;
}) {
  const slot = WIDTH / series.length;
  const barWidth = Math.max(slot * 0.7, 1);

  return (
    <g>
      {series.map((point, index) => {
        const top = Math.min(y(point.value), zeroLine);
        const barHeight = Math.abs(zeroLine - y(point.value));
        return (
          <rect
            key={point.date}
            x={index * slot + (slot - barWidth) / 2}
            y={top}
            width={barWidth}
            height={Math.max(barHeight, point.value === 0 ? 0 : 0.5)}
            fill={point.value < 0 ? "var(--red)" : colour}
          />
        );
      })}
    </g>
  );
}
