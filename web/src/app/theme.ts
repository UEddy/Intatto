import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "intatto.theme";

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

function systemDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** The effective theme, and a toggle that flips it (and remembers the choice). */
export function useTheme(): { dark: boolean; toggle: () => void } {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  const [sysDark, setSysDark] = useState(systemDark);

  useEffect(() => {
    applyTheme(choice);
  }, [choice]);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSysDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const dark = choice === "dark" || (choice === "system" && sysDark);
  const toggle = useCallback(() => {
    const next: ThemeChoice = dark ? "light" : "dark";
    setChoice(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // The choice still applies for this page view.
    }
  }, [dark]);
  return { dark, toggle };
}
