// A small radio switch between species, added to the front of a card's body; null when there is one species.
export function speciesSwitch(body: HTMLElement, name: string, names: readonly string[], onPick: (species: number) => void): HTMLElement | null {
  if (names.length < 2) return null;
  const seg = document.createElement("div");
  seg.className = "seg seg-mini stat-species";
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "Species");
  names.forEach((label, i) => {
    const l = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = String(i);
    input.checked = i === 0;
    input.addEventListener("change", () => onPick(i));
    const span = document.createElement("span");
    span.textContent = label;
    l.append(input, span);
    seg.append(l);
  });
  body.prepend(seg);
  return seg;
}
