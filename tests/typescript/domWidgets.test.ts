// @vitest-environment happy-dom
import { initCard } from "../../src/typescript/src/ui/overlays.ts";
import { initTooltips } from "../../src/typescript/src/ui/tooltip.ts";

describe("overlay card", () => {
  function card() {
    document.body.innerHTML = `<section><h2>Brain</h2><button class="ov-toggle"></button><div class="ov-body">x</div></section>`;
    const root = document.querySelector("section")!;
    return { root, button: root.querySelector("button")!, body: root.querySelector<HTMLElement>(".ov-body")! };
  }
  beforeEach(() => localStorage.clear());

  it("starts as requested and toggles with matching button text and aria state", () => {
    const { root, button, body } = card();
    const c = initCard(root, "k", true);
    expect(c.isExpanded()).toBe(false);
    expect(body.hidden).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Maximise brain");
    button.click();
    expect(c.isExpanded()).toBe(true);
    expect(body.hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Minimise brain");
  });

  it("remembers the state in localStorage and the saved state beats the default", () => {
    const first = card();
    initCard(first.root, "k", true);
    first.button.click();
    expect(localStorage.getItem("k")).toBe("max");
    const second = card();
    expect(initCard(second.root, "k", true).isExpanded()).toBe(true);
    second.button.click();
    expect(localStorage.getItem("k")).toBe("min");
    expect(initCard(card().root, "k", false).isExpanded()).toBe(false);
  });

  it("keeps working when storage throws", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const { root, button } = card();
    const c = initCard(root, "k", false);
    expect(c.isExpanded()).toBe(true);
    button.click();
    expect(c.isExpanded()).toBe(false);
    get.mockRestore();
    set.mockRestore();
  });
});

describe("tooltips", () => {
  let bubble: HTMLElement;
  beforeAll(() => {
    document.body.innerHTML = `<div id="bubble" hidden></div><span class="tip" id="a" data-tip="First">i</span><span class="tip" id="b" data-tip="Second">i</span><p id="other">x</p>`;
    bubble = document.getElementById("bubble")!;
    initTooltips(bubble); // listens on document, so once per file
  });
  const fire = (id: string, type: string) => document.getElementById(id)!.dispatchEvent(new Event(type, { bubbles: true }));

  it("shows the tip text on hover and hides it on leave", () => {
    fire("a", "mouseover");
    expect(bubble.hidden).toBe(false);
    expect(bubble.textContent).toBe("First");
    fire("a", "mouseout");
    expect(bubble.hidden).toBe(true);
  });

  it("shows on keyboard focus, switches tip on click and hides on a click elsewhere or Escape", () => {
    fire("a", "focusin");
    expect(bubble.textContent).toBe("First");
    fire("b", "click");
    expect(bubble.textContent).toBe("Second");
    fire("other", "click");
    expect(bubble.hidden).toBe(true);
    fire("a", "click");
    expect(bubble.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(bubble.hidden).toBe(true);
  });

  it("keeps the bubble inside the viewport", () => {
    window.innerWidth = 400;
    window.innerHeight = 300;
    const a = document.getElementById("a")!;
    a.getBoundingClientRect = () => ({ left: 395, right: 399, top: 10, bottom: 20, width: 4, height: 10 }) as DOMRect;
    fire("a", "mouseover");
    expect(parseFloat(bubble.style.left)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(bubble.style.top)).toBe(28); // below the target
  });
});
