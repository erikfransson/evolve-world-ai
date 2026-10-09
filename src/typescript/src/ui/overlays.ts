// Collapsible overlay cards; the minimised state is remembered in localStorage.
export interface Card {
  isExpanded(): boolean;
}

export function initCard(root: HTMLElement, storageKey: string, startMinimised: boolean): Card {
  const button = root.querySelector<HTMLButtonElement>(".ov-toggle")!;
  const body = root.querySelector<HTMLElement>(".ov-body")!;
  const title = root.querySelector("h2")!.textContent!.toLowerCase();
  let expanded = !startMinimised;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "min") expanded = false;
    else if (saved === "max") expanded = true;
  } catch {
    // storage blocked: keep the default
  }

  const apply = (): void => {
    body.hidden = !expanded;
    button.textContent = expanded ? "−" : "+";
    button.setAttribute("aria-expanded", String(expanded));
    const verb = expanded ? "Minimise" : "Maximise";
    button.setAttribute("aria-label", `${verb} ${title}`);
    button.title = verb;
  };
  button.addEventListener("click", () => {
    expanded = !expanded;
    apply();
    try {
      localStorage.setItem(storageKey, expanded ? "max" : "min");
    } catch {
      // storage blocked: state lasts for this page only
    }
  });
  apply();
  return { isExpanded: () => expanded };
}
