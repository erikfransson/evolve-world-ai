// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEcoView } from "../../src/typescript/src/ui/ecoPage.ts";
import type { EcoHandlers } from "../../src/typescript/src/ui/ecoPage.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";

// happy-dom leaves range inputs empty until filled, so fill the freshly built form with the defaults a browser shows.
vi.mock("../../src/typescript/src/ui/ecoSettingsForm.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../src/typescript/src/ui/ecoSettingsForm.ts")>();
  return { ...actual, buildEcoForm: (el: HTMLElement) => { actual.buildEcoForm(el); actual.fillEcoForm(DEFAULT_ECO_CONFIG); } };
});

const html = readFileSync(resolve(import.meta.dirname, "../../src/typescript/ecosystem/index.html"), "utf8").replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, "").replace(/<script[\s\S]*?<\/script>/g, "");

describe("Ecosystem extinction dialog", () => {
  it("Edit settings returns to idle and keeps the run's settings", () => {
    globalThis.ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} } as unknown as typeof ResizeObserver;
    HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
    Element.prototype.scrollIntoView = vi.fn();
    document.body.innerHTML = html;
    const onReset = vi.fn();
    const handlers = new Proxy({ onReset }, { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? vi.fn() }) as unknown as EcoHandlers;
    const view = createEcoView(handlers);
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
