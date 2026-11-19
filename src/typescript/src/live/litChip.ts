// The "Family lit" switch-off controls on the Selected creature card: shown while a family is lit, so the highlight can always be cleared there.
export function litLabel(founder: number, names: ReadonlyMap<number, string>): string {
  return names.get(founder) || `Founder #${founder}`;
}

// Which switch-offs show, given the lit family's label (null when nothing is lit) and whether the card's own family toggle is the pressed
// "Family lit" one. The open card shows `card` unless that toggle already is the off switch; the folded card's chip shows `chip`.
export function litSwitches(label: string | null, ownToggleOn: boolean): { card: string | null; chip: string | null } {
  return { card: ownToggleOn ? null : label, chip: label };
}

// `label` is null when nothing is lit. The label can be a visitor's name, so it goes in as text only. The ✕ is its own span, so a cut name keeps it.
export function syncLitChip(chip: HTMLElement, label: string | null): void {
  chip.hidden = label === null;
  if (label === null) return;
  const text = `Family lit: ${label}`;
  if (chip.firstElementChild?.textContent !== text || chip.childNodes.length !== 2) {
    const name = document.createElement("span");
    name.className = "lit-name";
    name.textContent = text;
    const x = document.createElement("span");
    x.className = "lit-x";
    x.setAttribute("aria-hidden", "true");
    x.textContent = "✕";
    chip.replaceChildren(name, x);
  }
  chip.setAttribute("aria-label", `Family lit: ${label}, switch off`); // starts with the visible words, for voice control
}
