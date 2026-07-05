function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// "N months ago" with the day clamped to the target month's length —
// naive `new Date(y, m - n, 31)` overflows (May 31 − 3 months → Mar 3).
function monthsAgo(n: number): Date {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() - n, 1);
  const daysInTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(now.getDate(), daysInTarget));
  return target;
}

export interface Preset {
  label: string;
  range: () => { start: string; end: string };
}

export const PRESETS: Preset[] = [
  {
    label: "3 months",
    range: () => ({ start: iso(monthsAgo(3)), end: iso(new Date()) }),
  },
  {
    label: "This month to date",
    range: () => {
      const now = new Date();
      return { start: iso(new Date(now.getFullYear(), now.getMonth(), 1)), end: iso(now) };
    },
  },
  {
    label: "Last month",
    range: () => {
      const now = new Date();
      return {
        start: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        end: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
    },
  },
  {
    label: "6 months",
    range: () => ({ start: iso(monthsAgo(6)), end: iso(new Date()) }),
  },
  {
    label: "1 year",
    range: () => ({ start: iso(monthsAgo(12)), end: iso(new Date()) }),
  },
  {
    label: "Last year",
    range: () => {
      const now = new Date();
      return {
        start: iso(new Date(now.getFullYear() - 1, 0, 1)),
        end: iso(new Date(now.getFullYear() - 1, 11, 31)),
      };
    },
  },
  {
    label: "This year to date",
    range: () => {
      const now = new Date();
      return { start: iso(new Date(now.getFullYear(), 0, 1)), end: iso(now) };
    },
  },
];

export default function DatePresets({
  onSelect,
}: {
  onSelect: (start: string, end: string) => void;
}) {
  return (
    <label>
      Quick range
      <select
        value=""
        onChange={(e) => {
          const preset = PRESETS.find((p) => p.label === e.target.value);
          if (preset) {
            const { start, end } = preset.range();
            onSelect(start, end);
          }
        }}
      >
        <option value="" disabled>
          Pick…
        </option>
        {PRESETS.map((p) => (
          <option key={p.label} value={p.label}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}
