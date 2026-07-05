import { createContext, useContext } from "react";
import { compactMoney, formatMoney } from "../api";

/** Demo mode: every monetary value renders as a mask so the app can be
 * shown around without exposing real numbers. Percentages are unaffected. */
export const DemoModeContext = createContext(false);

export function useDemoMode(): boolean {
  return useContext(DemoModeContext);
}

const MASK = "XXX$";

// Dollar amounts embedded in free text (descriptions like
// "ACH withdrawal of $3,724.26"). Deliberately anchored on "$" so masked
// card numbers and dates are left alone.
const AMOUNT_IN_TEXT = /\$\s?\d[\d,]*(?:\.\d+)?/g;

/** Formatting helpers that honor demo mode. Use these anywhere a money
 * string is needed outside plain JSX (chart axes, tooltips, titles). */
export function useMoney() {
  const demo = useDemoMode();
  return {
    demo,
    fmt: (amount: string | number, currency: string) =>
      demo ? MASK : formatMoney(amount, currency),
    fmtCompact: (v: number, currency: string) => (demo ? MASK : compactMoney(v, currency)),
    maskText: (text: string) => (demo ? text.replace(AMOUNT_IN_TEXT, MASK) : text),
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
