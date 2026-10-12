import type { ModePage } from "./ecoModes.ts";
import { terrainLegendHtml } from "./terrainLegend.ts";
import { GENTLE_TIP } from "./gentle.ts";

// The wording and drawings that shape the Ecosystem page.
export interface PageCopy {
  title: string;
  tagline: string;
  logo: string; // inside the banner's <svg>
  seasonTip: string;
  legend: readonly (readonly [swatch: string, label: string])[]; // the swatch is the <svg> inside the item
  pickTitles: Readonly<Record<string, readonly [label: string, title: string]>>; // by button id
  eatenLabel: string; // the Selected card's "eaten" row; a hunting page rewrites it per species
  popKeys: string; // the Population graph's key spans
  linBarLabel: string;
  extinct: string;
}

const tip = (text: string) => `<span class="tip" tabindex="0" role="img" aria-label="${text}" data-tip="${text}">ⓘ</span>`;

const circle = (r: number, y: number, hsl: string) =>
  `<clipPath id="swClip"><circle cx="10" cy="10" r="${r}" /></clipPath><circle cx="10" cy="10" r="${r}" fill="rgba(15, 23, 20, 0.85)" /><rect x="0" y="${y}" width="20" height="12" fill="${hsl}" clip-path="url(#swClip)" /><circle cx="10" cy="10" r="${r}" fill="none" stroke="${hsl}" stroke-width="1.6" />`;
const dot = (fill: string) => `<circle cx="10" cy="10" r="5" fill="${fill}" />`;
const ring = `<circle cx="10" cy="10" r="8" fill="none" stroke="#eef5f1" stroke-width="1.6" />`;

export const ECOSYSTEM_COPY: PageCopy = {
  title: "Ecosystem",
  tagline: "one shared world, no generations",
  logo: `<circle cx="13" cy="16" r="6" /><path d="M19 16 L29 8 M19 16 L30 16 M19 16 L29 24" />`,
  seasonTip: "The season now and the food regrowth multiplier it gives.",
  legend: [
    [circle(8, 8.4, "hsl(200, 75%, 58%)"), "Creature (fill = energy)"],
    [ring, "Selected creature"],
    [dot("#4ade80"), "Food"],
    [dot("#e040fb"), "Poison"],
  ],
  pickTitles: {
    pickAge: ["Oldest", "Select the oldest living creature"],
    pickChildren: ["Most children", "Select the living creature with the most children"],
    pickEaten: ["Most food", "Select the living creature that has eaten the most food"],
  },
  eatenLabel: "Food eaten",
  popKeys: `<span class="key pop">creatures</span><span class="key food">food</span>`,
  linBarLabel: "Share of living creatures by founder",
  extinct: "Every creature has died.",
};

const card = (id: string, cls: string, title: string, min: string, body: string, head = "") =>
  `<section id="${id}" class="ov ${cls}"${id === "selectedCard" || id === "brainCard" ? " hidden" : ""}>
            <header class="ov-head">
              <h2>${title}</h2>${head}
              <button class="ov-toggle" type="button" aria-expanded="true" aria-label="Minimise ${min}" title="Minimise">−</button>
            </header>
${body}
          </section>`;

// The page structure both pages share, filled from the page's spec. Inserted at the start of <body>, ahead of the page's script.
export function ecoBody(page: ModePage): string {
  const c = page.copy;
  const several = page.speciesColors.length > 0;
  const tiles = page.tiles.map((t) => `          <div class="${t.cls ?? "tile"}"><dt>${t.label}${tip(t.tip)}</dt><dd id="${t.id}">-</dd></div>`);
  const season = `          <div class="tile" id="statSeasonTile" hidden><dt>Season${tip(c.seasonTip)}</dt><dd id="statSeason">-</dd></div>`;
  tiles.splice(page.tiles.findIndex((t) => t.id === "statTime") + 1, 0, season);
  const pick = (id: string) => {
    const [label, title] = c.pickTitles[id]!;
    return `                <button id="${id}" class="secondary" type="button" title="${title}">${label}</button>`;
  };
  const legend = [...c.legend.map(([swatch, label]) => `              <li><svg viewBox="0 0 20 20" aria-hidden="true">${swatch}</svg>${label}</li>`), `              ${terrainLegendHtml()}`];
  const linSwitch = several
    ? `
              <div class="seg seg-mini lin-species" role="radiogroup" aria-label="Lineages of">
                <label><input type="radio" name="linSpecies" value="0" checked /><span>Prey</span></label>
                <label><input type="radio" name="linSpecies" value="1" /><span>Predators</span></label>
              </div>`
    : "";
  return `
    <header class="banner">
      <a class="back" href="../">← Evolve World</a>
      <svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
        ${c.logo.replace("/><", "/>\n        <")}
      </svg>
      <h1>${c.title}</h1>
      <span class="tagline">${c.tagline}</span>
    </header>
    <main class="layout">
      <aside class="panel">
        <section class="run">
          <div class="buttons">
            <button id="start" class="primary" type="button">Start</button>
            <button id="pause" class="secondary" type="button" disabled>Pause</button>
            <button id="reset" class="secondary" type="button" disabled>Reset</button>
          </div>
        </section>

        <dl class="stats">
${tiles.join("\n")}
        </dl>

        <section class="card">
          <h2>View</h2>
          <div class="toggle"><span class="lbl"><label class="name" for="rays">Show rays</label>${tip("Draw the vision rays of the selected creature, coloured by what they hit.")}</span><input id="rays" type="checkbox" role="switch" checked /></div>
          <div class="toggle"><span class="lbl"><label class="name" for="gentle">Gentle on CPU</label>${tip(GENTLE_TIP)}</span><input id="gentle" type="checkbox" role="switch" checked /></div>
          <div class="field">
            <div class="row"><span class="lbl"><span class="name">Speed</span>${tip("How fast the world runs compared with real time. 1× is real time. Max simulates as fast as possible and draws only a few frames per second.")}</span><span class="hint">× real time</span></div>
            <div class="seg" role="radiogroup" aria-label="Speed">
              <label><input type="radio" name="speed" value="1" /><span>1×</span></label>
              <label><input type="radio" name="speed" value="2" /><span>2×</span></label>
              <label><input type="radio" name="speed" value="4" checked /><span>4×</span></label>
              <label><input type="radio" name="speed" value="8" /><span>8×</span></label>
              <label><input type="radio" name="speed" value="16" /><span>16×</span></label>
              <label><input type="radio" name="speed" value="32" /><span>32×</span></label>
              <label><input type="radio" name="speed" value="max" /><span>Max</span></label>
            </div>
          </div>
        </section>

        <form id="setup" autocomplete="off">
          <div class="group-head">
            <h2>Settings</h2>
            <span class="lock-note">Locked while running</span>
          </div>
          <fieldset id="settings"></fieldset>
        </form>
      </aside>
      <section class="stage">
        <canvas id="view" tabindex="0" aria-label="World view. Drag to pan, scroll or pinch to zoom, arrow keys pan, plus and minus zoom, 0 fits the world."></canvas>
        <div id="note" class="note"></div>
        <div id="timer" class="timer" title="Simulated time" hidden></div>
        <div class="zoom" role="group" aria-label="Zoom">
          <button id="zoomIn" type="button" aria-label="Zoom in" title="Zoom in">+</button>
          <button id="zoomOut" type="button" aria-label="Zoom out" title="Zoom out">−</button>
          <button id="zoomFit" type="button" aria-label="Fit world to view" title="Fit world to view">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>
          </button>
        </div>
        <div class="ov-stack">
          ${card("legendCard", "ov-legend", "Legend", "legend", `            <ul class="ov-body legend">\n${legend.join("\n")}\n            </ul>`)}
          ${card(
            "selectedCard",
            "ov-selected",
            "Selected creature",
            "selected creature",
            `            <div class="ov-body sel-body">
              <div class="sel-only sel-energy">
                <div class="meter" role="meter" id="selMeter" aria-label="Energy" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="selFill"></span></div>
                <span id="selEnergy" class="sel-energy-val">-</span>
              </div>
              <dl class="sel-only sel-facts">
                <div><dt>Age</dt><dd id="selAge">-</dd></div>
                <div><dt>Children</dt><dd id="selChildren">-</dd></div>
                <div><dt${several ? ' id="selEatenLabel"' : ""}>${c.eatenLabel}</dt><dd id="selEaten">-</dd></div>
                <div><dt>Lineage depth</dt><dd id="selDepth">-</dd></div>
                <div><dt>Id</dt><dd id="selId">-</dd></div>
              </dl>
              <p class="sel-only sel-plan" id="selPlan"></p>
              <p class="sel-only sel-burn" title="Energy per second. Base is living, vision and neurons. Now adds thrust, turning and old age."><span>Energy use</span><span><b id="selBase">-</b> base</span><span><b id="selDrain">-</b> now</span><span>per second</span></p>
              <button id="selFounder" class="sel-only sel-founder" type="button" title="Highlight this founder's lineage in the world"><i id="selFounderSw"></i><span id="selFounderText"></span></button>
              <p class="sel-hint">Click a creature or pick one:</p>
              <div class="sel-pick" role="group" aria-label="Pick a creature">
${page.picks.map(([id]) => pick(id)).join("\n")}
              </div>
              <div class="sel-only sel-actions">
                <button id="follow" class="secondary" type="button" aria-pressed="false" title="Keep the view centred on this creature">Follow</button>
                <button id="worldView" class="secondary" type="button" title="Zoom out to the whole world">World view</button>
              </div>
            </div>`,
            several ? `\n              <span id="selSpecies" class="sel-species sel-only"></span>` : "",
          )}
          ${card("brainCard", "ov-brain", "Brain", "brain", `            <div class="ov-body"><canvas id="brainView"></canvas></div>`)}
          ${card(
            "graphCard",
            "ov-graph",
            "Population",
            "population",
            `            <div class="ov-body">
              <canvas id="graphView"></canvas>
              <div class="fit-foot">${c.popKeys}<span class="fit-note">simulated time</span></div>
            </div>`,
          )}
          ${card(
            "lineageCard",
            "ov-lineage",
            "Lineages",
            "lineages",
            `            <div class="ov-body">
              <div class="lin-bar" role="img" aria-label="${c.linBarLabel}"></div>
              <ul class="lin-list"></ul>
              <canvas class="lin-graph" aria-label="Share of each lineage over simulated time"></canvas>
              <div class="fit-foot"><span class="fit-note">share of creatures · simulated time</span><button class="lin-clear secondary" type="button" hidden>Show all</button></div>
            </div>`,
            linSwitch,
          )}
          ${card("traitCard", "ov-traits", "Traits now", "traits", `            <div class="ov-body"><ul class="trait-list"></ul><p class="stat-note">Living creatures now. Bars run from the lowest to the highest value.</p></div>`)}
          ${card("leaderCard", "ov-leaders", "Records", "records", `            <div class="ov-body"><ul class="lead-list"></ul><p class="stat-note">This run so far, dead creatures included. Times are simulated time lived.</p></div>`)}
        </div>
        <div id="extinct" class="scrim" hidden>
          <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="extinctTitle">
            <h2 id="extinctTitle">Extinct</h2>
            <p>${c.extinct} Reseed starts again with new founders and a new seed, or edit the settings and try again.</p>
            <div class="dialog-actions">
              <button id="reseed" class="primary" type="button">Reseed</button>
              <button id="editSettings" class="secondary" type="button">Edit settings</button>
            </div>
          </div>
        </div>
      </section>
    </main>`;
}
