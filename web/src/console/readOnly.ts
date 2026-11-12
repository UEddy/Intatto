import { createContext, useContext } from "react";

/**
 * True while the console shows someone else's vault read-only (#/vault?view=live). Its copy then
 * speaks of "the owner" and "this agent"; the owner's own console keeps "your".
 */
export const ReadOnlyContext = createContext(false);

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}
