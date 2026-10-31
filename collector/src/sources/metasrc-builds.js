// Reads the build widgets of a MetaSRC champion page into numbers. Pure: the scraper
// (metasrc.js) hands in the page's widgets as token lists, one per heading:
//   'T:<text>'                    a piece of text
//   'I:<alt>|<folder/file>|<tooltip id>'  an image
// Result, per champion and role (shares are 0-1; the model's builds.js blends them in):
//   runes  [{ keystone, sub, pick }]      keystone and secondary tree
//   spells [{ ids: [a, b], pick }]
//   start  [{ items: [ids], pick }]
//   items  [{ id, buy }]                  core and every item offered, with its buy rate
//   boots  [{ id, pick }]
//   path   [{ id, parts: [ids] }]         finished items in build order, with what is bought before each

// Summoner spell icon file -> spell id
const SPELL_ID = {
  SummonerFlash: 4, SummonerBarrier: 21, SummonerExhaust: 3, SummonerBoost: 1, SummonerHeal: 7,
  SummonerHaste: 6, SummonerDot: 14, SummonerSmite: 11, SummonerTeleport: 12, SummonerSnowball: 32,
  SummonerMana: 13,
};

const pct = (t) => {
  const m = /^(\d+(?:\.\d+)?)%$/.exec(t);
  return m ? Number(m[1]) / 100 : null;
};

const imageOf = (token) => {
  const [alt, file] = token.slice(2).split('|');
  const base = (file || '').split('/').pop().replace(/\.\w+$/, '');
  const id = /-(\d+)$/.exec(base);
  return { alt, base, id: id ? Number(id[1]) : null, folder: (file || '').split('/')[0] };
};

/** Splits a widget into its options: { images, counts, win, pick } per pair of percentages */
function options(tokens) {
  const out = [];
  let images = [];
  let counts = [];
  let rates = [];
  for (const t of tokens || []) {
    if (t.startsWith('I:')) {
      const img = imageOf(t);
      if (img.alt === 'gold coin') continue;
      images.push(img);
      counts.push(1);
    } else {
      const p = pct(t.slice(2));
      if (p !== null) {
        rates.push(p);
        if (rates.length === 2) {
          out.push({ images, counts, win: rates[0], pick: rates[1] });
          images = [];
          counts = [];
          rates = [];
        }
      } else if (/^\d+$/.test(t.slice(2)) && counts.length) counts[counts.length - 1] = Number(t.slice(2));
    }
  }
  return out;
}

/** widgets: { runes, spells, start, items, slots: [tokens], boots, path } -> entry, or null with nothing usable */
function parseBuild(widgets) {
  const runes = options(widgets.runes).filter((o) => o.images.length >= 2)
    .map((o) => ({ keystone: o.images[0].id, sub: o.images[1].id, pick: o.pick }))
    .filter((r) => r.keystone && r.sub);

  const spellOptions = options(widgets.spells);
  const head = spellOptions[0]?.images.map((i) => SPELL_ID[i.base]).filter(Boolean) || [];
  const spells = [];
  for (const o of spellOptions) {
    const ids = o.images.map((i) => SPELL_ID[i.base]).filter(Boolean);
    // Later options show only the spell that changes; the first one is shared
    const pair = ids.length === 2 ? ids : ids.length === 1 && head.length === 2 ? [head[0], ids[0]] : null;
    if (pair && pair[0] !== pair[1]) spells.push({ ids: pair, pick: o.pick });
  }

  const start = options(widgets.start)
    .map((o) => ({ items: o.images.flatMap((i, k) => (i.id ? Array(o.counts[k]).fill(i.id) : [])), pick: o.pick }))
    .filter((s) => s.items.length);

  const items = [];
  const buy = (id, rate) => id && items.push({ id, buy: rate });
  options(widgets.items).forEach((o) => o.images.forEach((i) => buy(i.id, o.pick)));
  for (const slot of widgets.slots || []) options(slot).forEach((o) => o.images.forEach((i) => buy(i.id, o.pick)));

  const boots = options(widgets.boots).filter((o) => o.images[0]?.id).map((o) => ({ id: o.images[0].id, pick: o.pick }));

  const path = [];
  let segment = [];
  for (const t of widgets.path || []) {
    if (!t.startsWith('I:')) continue;
    const img = imageOf(t);
    if (img.alt === 'gold coin') {
      if (segment.length) path.push({ id: segment[segment.length - 1], parts: segment.slice(0, -1) });
      segment = [];
    } else if (img.id) segment.push(img.id);
  }
  // The first starting item opens the first segment; it is not a part of that item
  const first = start[0]?.items || [];
  if (path.length && first.includes(path[0].parts[0])) path[0].parts = path[0].parts.slice(1);

  if (!runes.length && !spells.length && !start.length && !items.length) return null;
  return { runes, spells, start, items, boots, path };
}

module.exports = { parseBuild };
