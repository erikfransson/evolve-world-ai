// Whether the site was redeployed since this page loaded. Built files have hashed names and a deploy removes the old ones, so a
// page left open across a deploy can no longer start its workers; their load error carries no message.
export async function siteUpdated(doc: Document = document, fetcher: typeof fetch = fetch): Promise<boolean> {
  const mine = doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
  if (!mine) return false;
  try {
    const html = await (await fetcher(doc.location.href, { cache: "no-store" })).text();
    const src = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1];
    return src !== undefined && new URL(src, doc.location.href).href !== mine;
  } catch {
    return false; // offline or blocked: say nothing about a deploy
  }
}
