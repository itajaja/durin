import { useEffect, useRef, useState } from "react";

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Optional color dot rendered before the label. */
  color?: string;
}

/** A compact multiselect combobox: a select-looking button that opens a
 * checkbox list. An empty selection means "all" (no filter). */
export default function MultiSelect({
  label,
  allLabel,
  options,
  selected,
  onChange,
}: {
  label: string;
  allLabel: string;
  options: MultiSelectOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const summary =
    selected.size === 0
      ? allLabel
      : selected.size === 1
        ? (options.find((o) => selected.has(o.value))?.label ?? "1 selected")
        : `${selected.size} selected`;

  return (
    <div className="msel" ref={rootRef}>
      <span className="msel-label">{label}</span>
      <button
        type="button"
        className={`msel-btn${selected.size > 0 ? " msel-btn-active" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="msel-summary">{summary}</span>
        <span className="msel-caret">▾</span>
      </button>
      {open && (
        <div className="msel-pop" role="listbox" aria-multiselectable="true">
          <button
            type="button"
            className="msel-clear"
            disabled={selected.size === 0}
            onClick={() => onChange(new Set())}
          >
            {allLabel}
          </button>
          {options.map((o) => (
            <label key={o.value} className="msel-opt">
              <input
                type="checkbox"
                checked={selected.has(o.value)}
                onChange={() => toggle(o.value)}
              />
              {o.color && <span className="cat-dot" style={{ background: o.color }} />}
              <span className="msel-opt-label">{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
