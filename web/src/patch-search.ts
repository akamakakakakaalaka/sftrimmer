import type { PatchBrowserSettings, PatchInfo } from './contracts.ts';

/** Match the manual's name terms, prog8-15 program ranges and bank0 MSB filter. */
export function matchesPatchQuery(patch: PatchInfo, query: string): boolean {
  const name = patch.name.toLocaleLowerCase();
  return query.toLocaleLowerCase().trim().split(/\s+/).every(token => {
    if (!token) return true;
    // Ordinary names such as Progressive and Banker still use substring search.
    if (!/^(?:prog|bank)(?:[\d+.-]|nan$|infinity$)/.test(token)) return name.includes(token);
    const filter = /^(prog|bank)(\d+)(?:-(\d+))?$/.exec(token);
    if (!filter) return false;
    const first = Number(filter[2]);
    const last = filter[3] === undefined ? first : Number(filter[3]);
    if (first < 0 || last > 127 || first > last) return false;
    const value = filter[1] === 'prog' ? patch.program : patch.msb;
    return value >= first && value <= last;
  });
}

/** Soundbank content identity plus the full MIDI address survives patch renaming. */
export function patchIdentity(bankId: string, patch: PatchInfo): string {
  return JSON.stringify([bankId, patch.msb, patch.lsb, patch.program, patch.drums]);
}

export function sortPatchEntries<T extends { patch: PatchInfo; index: number }>(entries: T[], sort: PatchBrowserSettings['sort']): T[] {
  const result = [...entries];
  if (sort === 'none') return result;
  return result.sort((a, b) => {
    if (sort === 'name') return a.patch.name.localeCompare(b.patch.name);
    if (sort === 'program') {
      return a.patch.program - b.patch.program || a.patch.msb - b.patch.msb || a.patch.lsb - b.patch.lsb;
    }
    return a.patch.msb - b.patch.msb || a.patch.lsb - b.patch.lsb || a.patch.program - b.patch.program;
  });
}
