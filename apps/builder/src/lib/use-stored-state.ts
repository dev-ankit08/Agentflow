"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Object state remembered in this browser (localStorage), e.g. which panels are collapsed. Starts from `initial` so
 * server and client render the same, then loads the saved value; storage errors (private mode) are ignored.
 */
export function useStoredState<T extends object>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setValue((v) => ({ ...v, ...(JSON.parse(raw) as Partial<T>) }));
    } catch {
      // Unavailable or corrupt storage: keep the defaults.
    }
  }, [key]);

  const update = useCallback(
    (patch: Partial<T> | ((v: T) => Partial<T>)) =>
      setValue((v) => {
        const next = { ...v, ...(typeof patch === "function" ? patch(v) : patch) };
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Not remembered this time; the change still applies.
        }
        return next;
      }),
    [key],
  );

  return [value, update] as const;
}
