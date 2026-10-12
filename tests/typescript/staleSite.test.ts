// @vitest-environment happy-dom
import { siteUpdated } from "../../src/typescript/src/ui/staleSite.ts";

const page = (src: string): Document => {
  const doc = new DOMParser().parseFromString(`<script type="module" src="${new URL(src, "https://example.org/arena/").href}"></script>`, "text/html"); // parsed, not loaded
  Object.defineProperty(doc, "location", { value: new URL("https://example.org/arena/") });
  return doc;
};
const serving = (html: string) => (async () => new Response(html)) as unknown as typeof fetch;

describe("siteUpdated", () => {
  it("is true when the served page loads a different bundle", async () => {
    expect(await siteUpdated(page("../assets/index-OLD.js"), serving('<script type="module" crossorigin src="../assets/index-NEW.js"></script>'))).toBe(true);
  });
  it("is false for the same bundle, and when the page cannot be fetched", async () => {
    expect(await siteUpdated(page("../assets/index-A.js"), serving('<script type="module" crossorigin src="../assets/index-A.js"></script>'))).toBe(false);
    expect(await siteUpdated(page("../assets/index-A.js"), (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBe(false);
  });
});
