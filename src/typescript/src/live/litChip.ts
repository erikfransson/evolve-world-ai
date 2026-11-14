// The "Family lit" switch-off control on the Selected creature card's empty state: shown while a family is lit, so the highlight can always be cleared there.
export function litLabel(founder: number, names: ReadonlyMap<number, string>): string {
  return names.get(founder) || `Founder #${founder}`;
}

// `label` is null when nothing is lit. The label can be a visitor's name, so it goes in as text only.
export function syncLitChip(chip: HTMLElement, label: string | null): void {
  chip.hidden = label === null;
  if (label === null) return;
  const text = `Family lit: ${label} ✕`;
  if (chip.textContent !== text) chip.textContent = text;
  chip.setAttribute("aria-label", `Family lit: ${label}, switch off`); // starts with the visible words, for voice control
}
