import { useLayoutEffect, useState } from "react";
import { filterOptions, Option, OptionList, usePopover } from "./Dropdown";
import { Category, UNCATEGORIZED_COLOR } from "../types";

export function catOptions(
  categories: Category[],
  includeNone: boolean,
  noneLabel = "Uncategorized"
): Option[] {
  return [
    ...(includeNone
      ? [{ value: "none", label: noneLabel, color: UNCATEGORIZED_COLOR }]
      : []),
    ...categories.map((c) => ({
      value: String(c.id),
      label: c.emoji ? `${c.emoji} ${c.name}` : c.name,
      color: c.color,
    })),
  ];
}

/** A small anchored popover for picking a category (with type-to-filter),
 * used inline in table cells. Render it inside a positioned cell. */
export function InlinePicker({
  title,
  categories,
  includeUncategorized,
  noneLabel,
  onPick,
  onClose,
}: {
  title: string;
  categories: Category[];
  includeUncategorized: boolean;
  noneLabel?: string;
  onPick: (categoryId: number | null) => void;
  onClose: () => void;
}) {
  const options = catOptions(categories, includeUncategorized, noneLabel);
  const pick = (v: string) => onPick(v === "none" ? null : Number(v));
  const { rootRef, query } = usePopover(true, onClose, (q) => {
    const first = filterOptions(options, q)[0];
    if (first) pick(first.value);
  });
  const [openUp, setOpenUp] = useState(false);
  // Flip upward when the popover would poke below the viewport.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el && el.getBoundingClientRect().bottom > window.innerHeight - 8) {
      setOpenUp(true);
    }
  }, [rootRef]);
  return (
    <div ref={rootRef} className={`msel-pop inline-pop${openUp ? " inline-pop-up" : ""}`}>
      <div className="inline-pop-title">{title}</div>
      <OptionList options={options} query={query} onPick={pick} />
    </div>
  );
}
