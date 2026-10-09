// Tooltips: one shared fixed bubble, so the scrolling sidebar cannot clip it.
export function initTooltips(bubble: HTMLElement): void {
  let tipOwner: HTMLElement | null = null;
  function showTip(el: HTMLElement): void {
    tipOwner = el;
    bubble.textContent = el.dataset.tip ?? "";
    bubble.hidden = false;
    const r = el.getBoundingClientRect();
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    const below = r.bottom + 8 + h <= window.innerHeight;
    bubble.style.left = `${left}px`;
    bubble.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - 8 - h)}px`;
  }
  function hideTip(): void {
    tipOwner = null;
    bubble.hidden = true;
  }
  const tipOf = (t: EventTarget | null): HTMLElement | null => (t as HTMLElement | null)?.closest?.<HTMLElement>(".tip") ?? null;
  document.addEventListener("mouseover", (e) => { const t = tipOf(e.target); if (t) showTip(t); });
  document.addEventListener("mouseout", (e) => { if (tipOf(e.target)) hideTip(); });
  document.addEventListener("focusin", (e) => { const t = tipOf(e.target); if (t) showTip(t); });
  document.addEventListener("focusout", (e) => { if (tipOf(e.target)) hideTip(); });
  document.addEventListener("click", (e) => {
    const t = tipOf(e.target);
    if (t && t !== tipOwner) showTip(t); // tap on touch
    else if (!t) hideTip();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
  document.addEventListener("scroll", () => { if (tipOwner) showTip(tipOwner); }, true);
}
