// MetaSRC scraper source for Itachio collector.
// Scrapes Diamond+ tier list, team synergies and strong/weak matchups from metasrc.com.
//
// Outputs standard format for src/normalize.js:
//   meta: [{ champion, role, score (0-100), tier, win_rate, pick_rate, ban_rate, games }]
//   synergy: [{ champion, role, ally, strength (-1..1), win_rate, games }]
//   matchup: [{ champion, role, opponent, opponent_role, strength (-1..1), win_rate, games }]

const fs = require('node:fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const BASE_URL = 'https://www.metasrc.com/lol';
const RANKS = 'diamond+';
const { parseBuild } = require('./metasrc-builds');
const BUILD_MIN_ROLE = 2; // % of a champion's games: roles played less than this are left out
const BUILD_PAGES_AT_ONCE = 3;
const ROLE_URL = { top: 'top', jungle: 'jungle', middle: 'mid', bottom: 'adc', utility: 'support' };
const { championResolver } = require('../normalize');
const slugKey = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** Token lists of a build page's widgets, found by their headings (see metasrc-builds.js) */
function readBuildWidgets() {
  const widgets = { slots: [], rolePct: Number((document.body.innerText.match(/Role %:\s*([\d.]+)%/) || [])[1]) };
  for (const h of document.querySelectorAll('h2')) {
    const title = h.textContent.trim();
    const section = h.closest('header')?.nextElementSibling || h.parentElement.nextElementSibling;
    if (!section) continue;
    const tokens = [];
    const walk = (n) => {
      if (n.nodeType === 3) {
        const s = n.textContent.trim();
        if (s) tokens.push(`T:${s}`);
      } else if (n.nodeType === 1) {
        if (n.tagName === 'IMG') tokens.push(`I:${n.alt}|${(n.src || '').split('/').slice(-2).join('/').split('?')[0]}`);
        else n.childNodes.forEach(walk);
      }
    };
    walk(section);
    if (/Runes$/.test(title)) widgets.runes = tokens;
    else if (/^Summoner Spells/.test(title)) widgets.spells = tokens;
    else if (/^Starting Items/.test(title)) widgets.start = tokens;
    else if (/^Slot \d+ Item Options/.test(title)) widgets.slots.push(tokens);
    else if (/Items$/.test(title)) widgets.items = tokens;
    else if (/Boots$/.test(title)) widgets.boots = tokens;
    else if (/^Item Build Order/.test(title)) widgets.path = tokens;
  }
  return widgets;
}

// Find Chrome or Edge executable on Windows
function findBrowserPath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined; // fallback to puppeteer default if any
}

// Convert shorthand games (e.g. "1.2M", "52.6K", "945") to number
function parseGames(str) {
  if (!str) return 0;
  const s = String(str).trim().toUpperCase();
  if (s.endsWith('M')) return Math.round(parseFloat(s) * 1_000_000);
  if (s.endsWith('K')) return Math.round(parseFloat(s) * 1_000);
  const n = parseInt(s.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

// Convert "52.5%" -> 52.5
function parsePct(str) {
  if (!str) return null;
  const m = String(str).match(/([+-]?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

module.exports = {
  name: 'metasrc',

  async collect({ env, log, client, dryRun, publish }) {
    const executablePath = findBrowserPath();
    log(`starting browser at ${executablePath || 'default'}...`);

    const browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1920,1080',
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      // Block useless resource types to make scraping 5x faster
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = req.resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(type)) req.abort();
        else req.continue();
      });

      // 1. Scrape Diamond+ Tier Lists for all 5 roles to get all champions and accurate roles
      const ROLE_PATHS = [
        { path: 'top', role: 'top' },
        { path: 'jungle', role: 'jungle' },
        { path: 'mid', role: 'middle' },
        { path: 'adc', role: 'bottom' },
        { path: 'support', role: 'utility' },
      ];

      const meta = [];
      const uniqueChamps = new Map();
      let patch = null;

      for (const rp of ROLE_PATHS) {
        const tierListUrl = `${BASE_URL}/tier-list/${rp.path}?ranks=${RANKS}`;
        log(`fetching tier list for ${rp.role}: ${tierListUrl}`);
        try {
          await page.goto(tierListUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(() => {});

          const extracted = await page.evaluate((defaultRole) => {
            const titleMatch = document.title.match(/(\d+\.\d+)/);
            const currentPatch = titleMatch ? titleMatch[1] : null;

            const rows = [];
            const trs = Array.from(document.querySelectorAll('table tbody tr'));
            for (const tr of trs) {
              const cells = Array.from(tr.querySelectorAll('td'));
              if (cells.length < 5) continue;

              const champLink = tr.querySelector('a[href*="/champions/"]');
              if (!champLink) continue;

              const href = champLink.getAttribute('href') || '';
              const slugMatch = href.match(/\/champions\/([^/?]+)/);
              if (!slugMatch) continue;

              const slug = slugMatch[1].toLowerCase();
              const tier = cells[2] ? cells[2].textContent.trim() : null;
              const scoreText = cells[3] ? cells[3].textContent.trim().split(/\s+/)[0] : '';
              const winText = cells[4] ? cells[4].textContent.trim().split(/\s+/)[0] : '';
              const pickText = cells[5] ? cells[5].textContent.trim().split(/\s+/)[0] : '';
              const banText = cells[7] ? cells[7].textContent.trim().split(/\s+/)[0] : '';
              const gamesText = cells[9] ? cells[9].textContent.trim().split(/\s+/)[0] : '';

              rows.push({
                slug,
                role: defaultRole,
                tier,
                score: scoreText,
                winRate: winText,
                pickRate: pickText,
                banRate: banText,
                games: gamesText,
              });
            }
            return { currentPatch, rows };
          }, rp.role);

          if (!patch && extracted.currentPatch) patch = extracted.currentPatch;

          for (const r of extracted.rows) {
            const score = parseFloat(r.score);
            if (!Number.isFinite(score)) continue;

            meta.push({
              champion: r.slug,
              role: r.role,
              score,
              tier: r.tier,
              win_rate: parsePct(r.winRate),
              pick_rate: parsePct(r.pickRate),
              ban_rate: parsePct(r.banRate),
              games: parseGames(r.games),
            });

            if (!uniqueChamps.has(r.slug)) {
              uniqueChamps.set(r.slug, { slug: r.slug, role: r.role });
            }
          }
        } catch (e) {
          log(`warning: failed fetching tier list for ${rp.role}: ${e.message}`);
        }
      }

      log(`found ${meta.length} meta entries across all roles (patch ${patch || 'unknown'})`);

      const synergy = [];
      const matchup = [];

      // 2. Scrape champion builds for Synergies and Strong/Weak Matchups
      const champList = Array.from(uniqueChamps.values());
      log(`scraping synergies and matchups for ${champList.length} champions...`);

      let processed = 0;
      for (const c of champList) {
        const buildUrl = `${BASE_URL}/champions/${c.slug}/build?ranks=${RANKS}`;
        try {
          await page.goto(buildUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForSelector('h2, h3, summary', { timeout: 6000 }).catch(() => {});

          const detail = await page.evaluate((candidateSlug) => {
            const synList = [];
            const strongList = [];
            const weakList = [];

            // A. Synergies
            const synHeading = Array.from(document.querySelectorAll('h2, summary')).find((el) =>
              el.textContent.includes('Team Synergies'),
            );
            if (synHeading) {
              const container =
                synHeading.closest('section') ||
                synHeading.closest('div.flex-col') ||
                synHeading.parentElement;
              if (container) {
                container.querySelectorAll('a[href*="/champions/"]').forEach((a) => {
                  const m = (a.getAttribute('href') || '').match(/\/champions\/([^/?]+)(?:\/([a-z]+))?\/build/);
                  if (m && m[1].toLowerCase() !== candidateSlug) {
                    const row = a.closest('tr') || a.parentElement;
                    const text = row ? row.textContent : '';
                    // Look for +X.X% synergy delta
                    const deltaMatch = text.match(/\+(\d+(?:\.\d+)?)%/);
                    const winMatch = text.match(/(\d+(?:\.\d+)?)%/);
                    const gamesMatch = text.match(/(\d+(?:\.\d+)?[KM]?)\b/);
                    synList.push({
                      ally: m[1].toLowerCase(),
                      delta: deltaMatch ? parseFloat(deltaMatch[1]) : 1.5,
                      winRate: winMatch ? parseFloat(winMatch[1]) : null,
                      games: gamesMatch ? gamesMatch[1] : null,
                    });
                  }
                });
              }
            }

            // B. Strong Against & Weak Against (Even Against is intentionally omitted)
            const matchupHeading = Array.from(document.querySelectorAll('h2, summary')).find((el) =>
              el.textContent.includes('Matchups'),
            );
            const matchupSection = matchupHeading
              ? matchupHeading.closest('section') || matchupHeading.parentElement
              : document;

            const extractMatchups = (titlePattern) => {
              const list = [];
              const heading = Array.from(matchupSection.querySelectorAll('h3, summary, h4')).find((el) =>
                titlePattern.test(el.textContent),
              );
              if (heading) {
                const sub = heading.closest('div') || heading.parentElement;
                if (sub) {
                  sub.querySelectorAll('a[href*="/champions/"]').forEach((a) => {
                    const m = (a.getAttribute('href') || '').match(/\/champions\/([^/?]+)(?:\/([a-z]+))?\/build/);
                    if (m && m[1].toLowerCase() !== candidateSlug) {
                      const text = a.textContent || '';
                      const winMatch = text.match(/(\d+(?:\.\d+)?)%/);
                      const gamesMatch = text.match(/(\d+(?:\.\d+)?[KM]?)\b/);
                      list.push({
                        opponent: m[1].toLowerCase(),
                        opponentRole: m[2] ? m[2].toLowerCase() : null,
                        winRate: winMatch ? parseFloat(winMatch[1]) : null,
                        games: gamesMatch ? gamesMatch[1] : null,
                      });
                    }
                  });
                }
              }
              return list;
            };

            const strong = extractMatchups(/Strong Against/i);
            const weak = extractMatchups(/Weak Against/i);

            return { synergies: synList, strong, weak };
          }, c.slug);

          // Map synergies to strength (-1..1)
          // 1 winrate point ~ 0.1 strength; delta +2% -> strength ~ 0.20
          for (const s of detail.synergies || []) {
            const str = Math.min(1.0, Math.max(0.0, (s.delta || 1.5) / 10.0));
            synergy.push({
              champion: c.slug,
              role: c.role,
              ally: s.ally,
              strength: Number(str.toFixed(3)),
              win_rate: s.winRate,
              games: parseGames(s.games),
            });
          }

          // Map Strong Against -> strength +0.10 .. +0.50
          for (const st of detail.strong || []) {
            const diff = st.winRate ? (st.winRate - 50.0) / 10.0 : 0.25;
            const str = Math.min(1.0, Math.max(0.05, diff));
            matchup.push({
              champion: c.slug,
              role: c.role,
              opponent: st.opponent,
              opponent_role: st.opponentRole,
              strength: Number(str.toFixed(3)),
              win_rate: st.winRate,
              games: parseGames(st.games),
            });
          }

          // Map Weak Against -> strength -0.10 .. -0.50
          for (const wk of detail.weak || []) {
            const diff = wk.winRate ? (wk.winRate - 50.0) / 10.0 : -0.25;
            const str = Math.max(-1.0, Math.min(-0.05, diff));
            matchup.push({
              champion: c.slug,
              role: c.role,
              opponent: wk.opponent,
              opponent_role: wk.opponentRole,
              strength: Number(str.toFixed(3)),
              win_rate: wk.winRate,
              games: parseGames(wk.games),
            });
          }
        } catch (err) {
          log(`warning: could not scrape ${c.slug}: ${err.message}`);
        }

        processed++;
        if (processed % 25 === 0 || processed === champList.length) {
          log(`progress: ${processed}/${champList.length} champions scraped (synergy: ${synergy.length}, matchup: ${matchup.length})`);
        }
      }

      log(`scrape complete: ${meta.length} meta, ${synergy.length} synergies, ${matchup.length} matchups`);

      // 3. Runes, summoner spells, starting items, items and build paths of every champion
      // in every role it is played (the tier lists only show the top of each role)
      const builds = [];
      if (env.METASRC_BUILDS !== '0') {
        const known = await client.from('champions').select('id,slug,name');
        const champions = known.data || [];
        const resolve = championResolver(champions);
        const urlSlug = new Map(); // champion id -> slug MetaSRC uses, learned from its tier lists
        for (const m of meta) urlSlug.set(resolve(m.champion), m.champion);
        const targets = champions.flatMap((c) => Object.keys(ROLE_URL).map((role) => ({ c, role })));
        log(`scraping builds for ${champions.length} champions in 5 roles...`);
        let next = 0;
        const worker = async () => {
          const tab = await browser.newPage();
          await tab.setViewport({ width: 1920, height: 1080 });
          await tab.setRequestInterception(true);
          tab.on('request', (req) => (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType()) ? req.abort() : req.continue()));
          while (next < targets.length) {
            const { c, role } = targets[next++];
            const slugs = [...new Set([urlSlug.get(c.id), slugKey(c.slug), slugKey(c.name), slugKey(String(c.name).split(/[\s&.']/)[0])].filter(Boolean))];
            for (const slug of slugs) {
              try {
                await tab.goto(`${BASE_URL}/champions/${slug}/${ROLE_URL[role]}/build?ranks=${RANKS}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await tab.waitForSelector('img[src*="/static/items/"]', { timeout: 8000 }).catch(() => {});
                const widgets = await tab.evaluate(readBuildWidgets);
                const entry = parseBuild(widgets);
                if (!entry) continue;
                urlSlug.set(c.id, slug);
                if (widgets.rolePct >= BUILD_MIN_ROLE) builds.push({ champion: c.id, role, ...entry });
                break;
              } catch (err) {
                log(`warning: build of ${slug} ${role}: ${err.message}`);
              }
            }
            if (next % 100 === 0) log(`progress: ${next}/${targets.length} builds read (${builds.length} usable)`);
          }
          await tab.close();
        };
        await Promise.all(Array.from({ length: BUILD_PAGES_AT_ONCE }, worker));
        log(`builds: ${builds.length} champion roles`);
      }

      return {
        patch,
        meta,
        synergy,
        matchup,
        builds,
      };
    } finally {
      await browser.close();
    }
  },
};

