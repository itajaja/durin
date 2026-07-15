import { createContext, useContext } from "react";
import { compactMoney, formatMoney } from "../api";

/** Discrete mode: every monetary value renders as a mask so the app can
 * be shown around without exposing real numbers. Percentages are
 * unaffected. */
export const DiscreteModeContext = createContext(false);

export function useDiscreteMode(): boolean {
  return useContext(DiscreteModeContext);
}

const MASK = "$XXX";

// Dollar amounts embedded in free text (descriptions like
// "ACH withdrawal of $3,724.26"). Deliberately anchored on "$" so masked
// card numbers and dates are left alone.
const AMOUNT_IN_TEXT = /\$\s?\d[\d,]*(?:\.\d+)?/g;

/** Formatting helpers that honor discrete mode. Use these anywhere a money
 * string is needed outside plain JSX (chart axes, tooltips, titles). */
export function useMoney() {
  const discrete = useDiscreteMode();
  return {
    discrete,
    fmt: (amount: string | number, currency: string) =>
      discrete ? MASK : formatMoney(amount, currency),
    fmtCompact: (v: number, currency: string) => (discrete ? MASK : compactMoney(v, currency)),
    maskText: (text: string) => (discrete ? text.replace(AMOUNT_IN_TEXT, MASK) : text),
    /** Unformatted numeric string (for CSV cells) that still honors the mask. */
    plain: (amount: string | number) => (discrete ? MASK : String(amount)),
  };
}

/** The standard way to render a monetary value. */
export default function Money({
  amount,
  currency,
  className,
}: {
  amount: string | number;
  currency: string;
  className?: string;
}) {
  const { fmt } = useMoney();
  return <span className={className}>{fmt(amount, currency)}</span>;
}
