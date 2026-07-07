import { filterOptions, Highlight, Option, usePopover } from "./Dropdown";
import { useState } from "react";

export type MultiSelectOption = Option;

/** A compact multiselect combobox: a select-looking button that opens a
 * checkbox list. Type while open to filter the options (the query stays
 * invisible; matched letters are bolded); Enter toggles the first match.
 *
 * Two interaction models:
 * - default: empty selection means "all" (no filter); clicking a row
 *   toggles it; the top row clears.
 * - facet (facet=true): the selection is explicit — typically starting
 *   with every row selected. The checkbox toggles a row (additive), the
 *   label click selects ONLY that row, a little × removes it, and the top
 *   row re-selects everything.
 */
export default function MultiSelect({
  label,
  allLabel,
  options,
  selected,
  onChange,
  facet = false,
}: {
  label: string;
  allLabel: string;
  options: MultiSelectOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  facet?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const { rootRef, query } = usePopover(
    open,
    () => setOpen(false),
    (q) => {
      const first = filterOptions(options, q)[0];
      if (first) toggle(first.value);
    }
  );

  const allSelected = facet && options.every((o) => selected.has(o.value));

  const summary = facet
    ? allSelected
      ? allLabel
      : selected.size === 0
        ? "None selected"
        : selected.size === 1
          ? (options.find((o) => selected.has(o.value))?.label ?? "1 selected")
          : `${selected.size} selected`
    : selected.size === 0
      ? allLabel
      : selected.size === 1
        ? (options.find((o) => selected.has(o.value))?.label ?? "1 selected")
        : `${selected.size} selected`;

  const filterActive = facet ? !allSelected : selected.size > 0;
  const shown = filterOptions(options, query);

  return (
    <div className="msel" ref={rootRef}>
      <span className="msel-label">{label}</span>
      <button
        type="button"
        className={`msel-btn${filterActive ? " msel-btn-active" : ""}`}
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
            disabled={facet ? allSelected : selected.size === 0}
            onClick={() =>
              onChange(facet ? new Set(options.map((o) => o.value)) : new Set())
            }
          >
            {allLabel}
          </button>
          {shown.length === 0 && <div className="msel-empty">No matches</div>}
          {shown.map((o) => (
            <div key={o.value} className="msel-opt">
              <input
                type="checkbox"
                checked={selected.has(o.value)}
                onChange={() => toggle(o.value)}
                onClick={(e) => e.stopPropagation()}
                title={facet ? "Add or remove from the selection" : undefined}
              />
              {o.color && <span className="cat-dot" style={{ background: o.color }} />}
              <span
                className="msel-opt-label msel-opt-click"
                title={facet ? "Show only this" : undefined}
                onClick={() => (facet ? onChange(new Set([o.value])) : toggle(o.value))}
              >
                <Highlight text={o.label} query={query} />
              </span>
              {facet && (
                <button
                  type="button"
                  className="msel-x"
                  title="Remove from the selection"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = new Set(selected);
                    next.delete(o.value);
                    onChange(next);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
