// File names on a home whose disk ignores letter case (macOS's default) or Unicode composition (macOS's APFS):
// two remote files whose names differ only that way would be one file on home. The disk's behavior is measured, not
// guessed from the OS name.

export interface NameRules {
  /** `Photo.png` and `photo.png` are the same file on home. */
  foldCase: boolean;
  /** `é` written as one character and as `e` + accent are the same file on home. */
  foldForm: boolean;
}

export const EXACT_NAMES: NameRules = { foldCase: false, foldForm: false };

/** The name as home's disk compares it. */
export function nameKey(name: string, rules: NameRules): string {
  let key = rules.foldForm ? name.normalize("NFC") : name;
  if (rules.foldCase) key = key.toLowerCase();
  return key;
}

/**
 * Remote files that would land on the same home file: the first (in sorted order) is shown, the others are reported.
 * Returns the names to show, and for each shown name the ones it hides.
 */
export function resolveClashes(names: Iterable<string>, rules: NameRules): { shown: Set<string>; hidden: Map<string, string[]> } {
  const sorted = [...names].sort();
  const shown = new Set<string>();
  const hidden = new Map<string, string[]>();
  if (!rules.foldCase && !rules.foldForm) {
    for (const n of sorted) shown.add(n);
    return { shown, hidden };
  }
  const byKey = new Map<string, string>();
  for (const n of sorted) {
    const key = nameKey(n, rules);
    const first = byKey.get(key);
    if (first === undefined) {
      byKey.set(key, n);
      shown.add(n);
    } else hidden.set(first, [...(hidden.get(first) ?? []), n]);
  }
  return { shown, hidden };
}
