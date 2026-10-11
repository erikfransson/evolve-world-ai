// @vitest-environment happy-dom
import { pageBody } from "./pageLoader.ts";
import { createEcoView } from "../../src/typescript/src/ui/ecoPage.ts";
import type { EcoHandlers } from "../../src/typescript/src/ui/ecoPage.ts";
import { ECOSYSTEM_PAGE } from "../../src/typescript/src/ui/ecoModes.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";

// happy-dom leaves range inputs empty until filled, so fill the freshly built form with the defaults a browser shows.
vi.mock("../../src/typescript/src/ui/settingsForm.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../src/typescript/src/ui/settingsForm.ts")>();
  return {
    ...actual,
    buildForm: (el: HTMLElement, spec: Parameters<typeof actual.buildForm<EcoConfig>>[1]) => {
      const form = actual.buildForm(el, spec);
      form.fill(DEFAULT_ECO_CONFIG);
      return form;
    },
  };
});

const html = pageBody("ecosystem");

describe("Ecosystem extinction dialog", () => {
  it("Edit settings returns to idle and keeps the run's settings", () => {
    globalThis.ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} } as unknown as typeof ResizeObserver;
    HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
    Element.prototype.scrollIntoView = vi.fn();
    document.body.innerHTML = html;
    const onReset = vi.fn();
    const handlers = new Proxy({ onReset }, { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? vi.fn() }) as unknown as EcoHandlers;
    const view = createEcoView(handlers, ECOSYSTEM_PAGE);
    const config = { ...view.readConfig(), seed: 4242 };
    view.fillConfig(config);
    document.getElementById("start")!.click();
    view.showExtinct(12);
    expect(document.getElementById("extinct")!.hidden).toBe(false);
    document.getElementById("editSettings")!.click();
    expect(document.getElementById("extinct")!.hidden).toBe(true);
    expect(document.getElementById("start")!.hasAttribute("disabled")).toBe(false);
    expect(document.getElementById("settings")!.hasAttribute("disabled")).toBe(false);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(view.readConfig()).toEqual(config);
    expect(document.getElementById("setup")!.contains(document.activeElement)).toBe(true);
  });
});
