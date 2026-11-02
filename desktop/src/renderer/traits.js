// Hand-scored champion traits and the team-fit heuristic built on them (see docs/DRAFT_MODEL.md).
//
// The learned win model sees the draft only through win/loss labels, which are too noisy to
// teach composition rules (AP/AD balance, CC, frontline, a plan for the fight). This module
// scores every champion on a few traits and judges a team the way a coach would: a damage
// split, enough frontline/CC/engage for the plan it is going for, and picks that agree with
// each other. All outputs are in units of the model's strength spread (sd), so model.js can
// mix them with learned logits.
//
// Traits, 0-3 each (mg 0-10 = tenths of damage that is magic):
//   mg magic share   fr frontline   cc crowd control   en engage   pk poke / long range
//   pe peel / protect   ac area control (AoE, zones)   wc waveclear   sc scaling
//   pi pick / burst / catch   sp split push

(function (root) {
  const KEYS = ['mg', 'fr', 'cc', 'en', 'pk', 'pe', 'ac', 'wc', 'sc', 'pi', 'sp'];

  // id name  mg fr cc en pk pe ac wc sc pi sp   (name = Data Dragon id)
  const RAW = `
266 Aatrox 0 2 2 1 0 0 2 2 2 0 1
103 Ahri 10 0 1 0 1 0 1 2 1 2 0
84 Akali 9 0 1 1 0 0 1 2 1 3 0
166 Akshan 0 0 0 0 1 1 0 2 1 1 1
12 Alistar 8 3 3 3 0 3 2 0 1 0 0
799 Ambessa 0 2 1 2 0 0 1 2 1 1 2
32 Amumu 9 3 3 3 0 0 3 2 2 1 0
34 Anivia 10 0 3 1 2 1 3 3 3 0 0
1 Annie 10 0 3 2 1 0 2 1 1 1 0
523 Aphelios 0 0 1 0 2 0 2 2 3 0 0
22 Ashe 0 0 3 1 2 0 1 1 2 1 0
136 AurelionSol 10 0 2 0 2 0 3 3 3 0 0
893 Aurora 10 0 2 1 1 0 1 2 1 2 0
268 Azir 9 0 2 1 2 1 3 2 3 0 0
432 Bard 7 0 2 1 0 2 1 0 2 2 0
200 Belveth 2 1 1 1 0 0 1 2 3 0 1
53 Blitzcrank 8 2 2 2 0 0 0 0 1 3 0
63 Brand 10 0 1 0 2 0 3 3 1 0 0
201 Braum 3 3 3 2 0 3 1 0 1 0 0
233 Briar 1 1 1 1 0 0 0 1 1 2 1
51 Caitlyn 0 0 1 0 3 0 1 2 2 0 0
164 Camille 0 1 2 2 0 0 0 1 2 2 2
69 Cassiopeia 10 0 2 0 1 0 3 2 3 0 0
31 Chogath 8 3 3 1 0 0 2 2 3 1 0
42 Corki 6 0 0 0 3 0 1 3 2 0 0
122 Darius 0 2 2 1 0 0 1 2 2 1 2
131 Diana 9 1 2 2 0 0 2 2 1 2 0
119 Draven 0 0 1 0 0 0 1 1 1 1 0
36 DrMundo 1 3 1 0 0 0 1 2 2 0 2
245 Ekko 9 1 2 1 0 1 2 2 1 2 0
60 Elise 9 0 2 1 0 0 0 1 1 3 0
28 Evelynn 9 0 1 1 0 0 1 1 2 3 0
81 Ezreal 4 0 0 0 3 0 0 2 2 0 0
9 Fiddlesticks 10 0 3 3 0 0 3 2 1 2 0
114 Fiora 0 1 1 0 0 0 0 1 2 1 3
105 Fizz 9 0 1 1 0 0 0 1 1 3 0
3 Galio 10 3 3 3 0 2 2 2 2 0 0
41 Gangplank 0 1 1 0 1 0 2 2 3 0 0
86 Garen 0 3 1 0 0 0 0 2 1 0 2
150 Gnar 1 3 3 3 1 0 3 2 2 0 0
79 Gragas 8 2 3 3 0 0 3 2 2 1 0
104 Graves 0 1 0 1 1 0 1 2 2 1 0
887 Gwen 9 1 1 1 0 0 1 2 3 0 2
120 Hecarim 1 2 2 3 0 0 1 2 1 2 0
74 Heimerdinger 10 0 2 0 2 0 3 3 2 0 2
910 Hwei 10 0 2 0 3 0 3 3 3 0 0
420 Illaoi 1 2 1 0 0 0 2 2 2 0 2
39 Irelia 3 2 2 2 0 0 1 2 1 1 2
427 Ivern 7 1 2 1 0 3 1 0 1 0 0
40 Janna 9 0 2 0 0 3 0 0 1 0 0
59 JarvanIV 1 3 2 3 0 0 2 1 1 1 0
24 Jax 3 2 2 2 0 0 0 1 3 1 3
126 Jayce 0 1 1 1 3 0 0 2 1 1 1
202 Jhin 0 0 1 0 2 0 1 1 2 1 0
222 Jinx 0 0 1 0 1 0 2 3 3 0 0
145 Kaisa 4 0 0 0 1 0 1 1 3 1 0
429 Kalista 0 0 1 1 0 1 1 1 1 1 0
43 Karma 10 0 2 0 3 2 1 2 1 0 0
30 Karthus 10 0 1 0 1 0 3 3 3 0 0
38 Kassadin 9 1 1 1 0 0 0 2 3 2 0
55 Katarina 7 0 0 0 0 0 2 2 1 2 0
10 Kayle 6 0 1 0 1 1 2 2 3 0 0
141 Kayn 1 2 1 1 0 0 1 2 2 2 0
85 Kennen 10 1 3 3 0 0 3 2 1 0 1
121 Khazix 0 0 1 1 0 0 0 1 1 3 0
203 Kindred 1 0 1 0 1 1 0 1 3 0 0
240 Kled 0 2 1 2 0 0 0 1 1 1 1
96 KogMaw 5 0 1 0 2 0 1 2 3 0 0
897 KSante 1 3 2 1 0 0 1 1 1 0 2
7 Leblanc 10 0 1 0 1 0 0 2 1 3 0
64 LeeSin 0 1 2 2 0 0 0 1 1 3 0
89 Leona 9 3 3 3 0 1 1 0 1 0 0
876 Lillia 10 1 2 1 0 0 3 3 3 0 0
127 Lissandra 10 1 3 2 0 0 2 2 1 1 0
236 Lucian 1 0 0 0 1 0 0 2 1 1 0
117 Lulu 9 0 2 0 1 3 0 1 2 0 0
99 Lux 10 0 2 0 3 1 2 2 1 1 0
54 Malphite 8 3 3 3 0 0 3 2 1 0 0
90 Malzahar 10 0 3 0 1 0 2 3 1 1 0
57 Maokai 8 3 3 3 0 1 2 1 2 0 0
11 MasterYi 0 0 0 0 0 0 0 1 2 0 2
800 Mel 10 0 1 0 2 1 2 2 2 0 0
902 Milio 9 0 1 0 0 3 0 0 1 0 0
21 MissFortune 0 0 1 0 1 0 3 2 2 0 0
62 MonkeyKing 1 2 3 3 0 0 2 1 1 1 0
82 Mordekaiser 9 2 1 0 0 0 2 2 2 1 1
25 Morgana 10 0 3 0 2 3 2 1 1 1 0
950 Naafiri 0 0 0 1 0 0 0 1 1 3 0
267 Nami 9 0 2 0 1 3 1 0 1 0 0
75 Nasus 3 3 1 0 0 0 1 2 3 0 2
111 Nautilus 8 3 3 3 0 0 1 0 1 3 0
518 Neeko 10 0 3 2 1 0 3 2 1 2 0
76 Nidalee 9 0 0 0 3 0 0 2 1 2 0
895 Nilah 0 0 1 1 0 0 1 2 2 0 0
56 Nocturne 0 1 2 3 0 0 0 1 1 3 0
20 Nunu 7 2 2 3 0 0 2 1 1 1 0
2 Olaf 0 2 1 2 0 0 0 2 1 0 1
61 Orianna 10 0 2 1 1 1 3 2 2 0 0
516 Ornn 3 3 3 3 0 1 3 2 2 0 0
80 Pantheon 0 1 2 2 0 0 0 1 0 2 0
78 Poppy 1 3 3 2 0 2 0 1 1 2 0
555 Pyke 0 1 2 2 0 0 0 0 1 3 0
246 Qiyana 0 0 2 2 0 0 2 1 1 3 0
133 Quinn 0 0 1 0 0 0 0 1 1 1 2
497 Rakan 7 1 2 3 0 2 1 0 1 0 0
33 Rammus 5 3 3 3 0 0 0 0 1 1 0
421 RekSai 1 2 2 2 0 0 0 1 1 2 0
526 Rell 6 3 3 3 0 1 1 0 1 1 0
888 Renata 9 0 3 0 0 3 2 0 2 1 0
58 Renekton 0 2 2 1 0 0 0 2 1 1 1
107 Rengar 0 1 1 1 0 0 0 1 1 3 0
92 Riven 0 1 2 2 0 0 0 1 1 2 2
68 Rumble 10 2 2 1 1 0 3 3 2 0 1
13 Ryze 10 1 2 1 0 1 2 2 3 0 1
360 Samira 0 0 1 1 0 0 2 1 2 1 0
113 Sejuani 5 3 3 3 0 0 1 1 1 0 0
235 Senna 0 0 2 0 3 2 1 1 3 0 0
147 Seraphine 10 0 2 1 2 2 3 2 2 0 0
875 Sett 0 3 2 1 0 0 1 1 1 0 0
35 Shaco 4 0 1 0 0 0 0 1 1 3 0
98 Shen 2 3 2 3 0 2 0 1 1 1 0
102 Shyvana 5 2 0 1 0 0 2 3 2 0 0
27 Singed 10 3 3 1 0 0 1 1 2 1 0
14 Sion 5 3 3 2 0 0 1 2 3 0 0
15 Sivir 0 0 0 0 1 1 2 3 2 0 0
72 Skarner 6 3 3 3 0 0 1 1 1 2 0
901 Smolder 3 0 0 0 1 0 2 3 3 0 0
37 Sona 9 0 2 0 2 3 2 0 3 0 0
16 Soraka 9 0 2 0 1 3 0 0 2 0 0
50 Swain 10 2 3 1 1 0 3 2 2 0 0
517 Sylas 9 1 1 1 0 0 1 2 2 2 0
134 Syndra 10 0 2 0 2 2 2 2 2 2 0
223 TahmKench 6 3 2 1 0 3 0 0 1 1 0
163 Taliyah 10 0 2 1 2 1 2 2 1 0 0
91 Talon 0 0 1 1 0 0 0 1 1 3 1
44 Taric 7 3 2 2 0 3 1 0 1 0 0
17 Teemo 9 0 1 0 2 0 1 2 1 0 2
412 Thresh 8 1 2 2 1 3 1 0 1 2 0
18 Tristana 1 0 1 1 0 0 1 1 3 0 0
48 Trundle 1 2 2 1 0 0 0 1 1 1 2
23 Tryndamere 0 1 0 0 0 0 0 1 2 0 3
4 TwistedFate 8 0 2 1 0 0 1 3 2 2 0
29 Twitch 0 0 1 0 0 0 1 1 3 1 0
77 Udyr 5 3 2 1 0 0 1 2 2 0 0
6 Urgot 0 3 2 1 0 0 1 2 2 1 1
110 Varus 3 0 2 0 3 0 2 1 2 1 0
67 Vayne 0 0 1 0 0 0 0 1 3 0 1
45 Veigar 10 0 2 0 1 0 2 2 3 1 0
161 Velkoz 10 0 2 0 3 0 2 2 2 0 0
711 Vex 10 0 2 1 1 0 2 2 2 1 0
254 Vi 0 2 2 3 0 0 0 1 1 3 0
234 Viego 1 2 1 1 0 0 1 2 2 1 0
112 Viktor 10 0 2 0 2 0 3 3 3 0 0
8 Vladimir 10 1 1 0 0 1 2 2 3 1 0
106 Volibear 4 3 2 3 0 0 1 2 1 1 0
19 Warwick 4 2 2 2 0 0 0 1 1 3 0
498 Xayah 0 0 1 0 0 2 2 1 3 0 0
101 Xerath 10 0 2 0 3 0 2 2 2 2 0
5 XinZhao 0 2 2 3 0 0 0 1 1 1 0
157 Yasuo 0 0 2 1 0 1 1 1 3 0 0
777 Yone 5 1 2 2 0 0 1 2 2 1 1
83 Yorick 2 2 1 0 0 0 0 2 1 0 3
804 Yunara 3 0 0 0 1 0 1 2 3 0 0
904 Zaahen 0 2 1 1 0 0 0 1 2 1 1
350 Yuumi 9 0 1 0 1 3 0 0 3 0 0
154 Zac 8 3 3 3 0 0 2 2 1 1 0
238 Zed 0 0 0 0 0 0 0 1 1 3 1
221 Zeri 0 0 0 0 1 0 1 3 3 0 0
115 Ziggs 10 0 1 0 3 0 2 3 2 0 0
26 Zilean 10 0 2 1 1 2 1 2 2 0 0
142 Zoe 10 0 2 0 2 0 0 1 1 2 0
143 Zyra 10 0 3 0 2 0 3 2 2 0 0
`;

  // Champions missing from the table (new releases): a profile from the primary class
  const FALLBACK = {
    Tank: [5, 3, 2, 2, 0, 1, 1, 1, 1, 0, 0],
    Fighter: [2, 2, 1, 1, 0, 0, 1, 2, 1, 1, 1],
    Mage: [10, 0, 2, 0, 2, 0, 2, 2, 2, 0, 0],
    Marksman: [0, 0, 1, 0, 1, 0, 1, 2, 3, 0, 0],
    Assassin: [3, 0, 1, 1, 0, 0, 0, 1, 1, 3, 0],
    Support: [7, 1, 2, 1, 1, 2, 1, 0, 1, 0, 0],
    None: [5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
  };

  const BY_ID = new Map();
  const BY_NAME = new Map();
  const toProfile = (v) => {
    const p = Object.fromEntries(KEYS.map((k, i) => [k, v[i]]));
    p.mg /= 10;
    return p;
  };
  for (const line of RAW.trim().split('\n')) {
    const [id, name, ...v] = line.trim().split(/\s+/);
    BY_ID.set(Number(id), toProfile(v.map(Number)));
    BY_NAME.set(name, Number(id));
  }

  const traitsOf = (id, tag) => BY_ID.get(id) || toProfile(FALLBACK[tag] || FALLBACK.None);

  // Duo pairs worth taking together (3 strong, 2 good, 1 nice), same name keys as RAW
  const PAIR_TEXT = `
Jinx Lulu 3
Jinx Milio 2
Jinx Nami 2
Jinx Leona 2
Jinx Thresh 1
Jinx Braum 1
Kaisa Nautilus 3
Kaisa Nami 2
Kaisa Leona 2
Lucian Nami 3
Lucian Braum 2
Lucian Rell 2
Lucian Thresh 2
Lucian Senna 3
Draven Leona 3
Draven Thresh 2
Draven Nautilus 2
Draven Alistar 2
Draven Pyke 2
MissFortune Leona 3
MissFortune Amumu 3
MissFortune Nautilus 2
MissFortune Alistar 2
MissFortune Braum 1
Xayah Rakan 3
Xayah Taric 2
Xayah Braum 1
Ashe Leona 2
Ashe Lux 2
Ashe Zyra 2
Ashe Braum 1
Samira Nautilus 3
Samira Leona 3
Samira Alistar 3
Samira Rell 2
Tristana Braum 2
Tristana Leona 2
Tristana Janna 1
Kalista Alistar 3
Kalista Thresh 3
Kalista Rakan 2
Kalista Rell 2
Ezreal Karma 3
Ezreal Lulu 2
Ezreal Yuumi 2
Jhin Morgana 2
Jhin Zyra 2
Varus Lux 2
Varus Karma 2
Varus Alistar 2
Sivir Taric 2
Sivir Lulu 2
Sivir Rell 2
KogMaw Lulu 3
KogMaw Braum 2
KogMaw Janna 2
Twitch Lulu 2
Twitch Yuumi 2
Aphelios Alistar 2
Aphelios Leona 2
Vayne Lulu 3
Vayne Janna 2
Vayne Thresh 2
Zeri Lulu 3
Zeri Yuumi 2
Zeri Janna 2
Smolder Lulu 2
Caitlyn Lux 3
Caitlyn Morgana 2
Caitlyn Zyra 2
Yasuo Malphite 3
Yasuo Alistar 3
Yasuo Diana 2
Yasuo Gragas 2
Yasuo Rakan 2
Yasuo JarvanIV 2
Yone Malphite 3
Yone Alistar 2
Orianna JarvanIV 2
Orianna Vi 2
Orianna MonkeyKing 3
`;
  const CURATED = new Map();
  for (const line of PAIR_TEXT.trim().split('\n')) {
    const [a, b, w] = line.trim().split(/\s+/);
    const x = BY_NAME.get(a);
    const y = BY_NAME.get(b);
    if (x === undefined || y === undefined) continue;
    CURATED.set(x < y ? `${x}:${y}` : `${y}:${x}`, Number(w));
  }
  const CURATED_SD = 0.1; // sd of strength per curated weight point

  // What a pair adds to a team, in sd. Curated duos, plus what the traits say: an engager
  // with AoE to follow up, a peeler with a scaling carry, two poke champions, two catch tools
  function pairBonus(a, tagA, b, tagB) {
    const curated = CURATED.get(a < b ? `${a}:${b}` : `${b}:${a}`) || 0;
    const x = traitsOf(a, tagA);
    const y = traitsOf(b, tagB);
    const carry = (p) => p.sc >= 3 && p.fr <= 1 && p.pe < 2;
    let derived = 0;
    if ((x.en >= 3 && y.ac >= 2) || (y.en >= 3 && x.ac >= 2)) derived += 0.08;
    if ((x.pe >= 3 && carry(y)) || (y.pe >= 3 && carry(x))) derived += 0.1;
    if (x.pk >= 2 && y.pk >= 2) derived += 0.05;
    if (x.pi >= 2 && y.pi >= 2) derived += 0.04;
    return curated * CURATED_SD + Math.min(0.15, derived);
  }

  // Typical trait per champion, to project the picks still to come
  const AVG = { fr: 1.0, cc: 1.5, en: 1.0, pk: 0.9, pe: 0.7, ac: 1.4, wc: 1.8, sc: 1.7, pi: 0.8, sp: 0.5 };
  const ARCH = ['pk', 'en', 'pe', 'pi', 'sp']; // what a team can be built around
  // What a full team needs, as sums over its five: by default and by plan
  const BASE = { fr: 4, cc: 6, en: 3, wc: 4, ac: 4, pk: 0, pe: 0, sc: 0, pi: 0, sp: 0 };
  const PLAN = {
    pk: { fr: 3, cc: 5, en: 1, wc: 5, ac: 4, pk: 7, pe: 3 },
    en: { fr: 5, cc: 8, en: 5, wc: 3, ac: 5 },
    pe: { fr: 4, cc: 6, en: 2, wc: 4, ac: 4, pe: 4, sc: 6 },
    pi: { fr: 2, cc: 8, en: 3, wc: 3, pi: 6 },
    sp: { fr: 3, cc: 5, en: 3, wc: 5, sp: 5 },
  };
  const WEIGHT = { fr: 1.8, cc: 2.0, en: 1.0, wc: 0.8, ac: 0.5, pk: 1.5, pe: 1.0, sc: 0.6, pi: 1.0, sp: 0.8 };
  const AP_LOW = 0.22; // magic share of a team's damage outside this band is a problem
  const AP_HIGH = 0.78;
  const DAMAGE_WEIGHT = 1.2;
  const COHERENCE_FLOOR = 0.34;
  const COHERENCE_WEIGHT = 1.0;

  /**
   * Judge a team (champion ids with their primary classes) by its traits: returns the
   * penalties in sd (0 = fine) for the damage split, the missing frontline/CC/engage/... of
   * the plan it is going for, and picks that do not agree. Picks still to come count as
   * average champions, so a half-built team is only judged on what it can no longer fix.
   */
  function teamFit(team) {
    const list = team.filter((m) => m && m.id).map((m) => traitsOf(m.id, m.tag));
    const n = list.length;
    const zero = { damage: 0, needs: 0, coherence: 0, penalty: 0, lacking: [] };
    if (!n) return zero;
    const open = Math.max(0, 5 - n);

    // Damage split: tanks do less of the damage, and open slots can still move the share
    let ap = 0;
    let weight = 0;
    for (const p of list) {
      const w = 1 - 0.15 * p.fr;
      ap += w * p.mg;
      weight += w;
    }
    const hi = (ap + open * 0.85 * 0.9) / (weight + open * 0.85);
    const lo = (ap + open * 0.85 * 0.1) / (weight + open * 0.85);
    const now = ap / weight;
    const best = hi < AP_LOW ? AP_LOW - hi : lo > AP_HIGH ? lo - AP_HIGH : 0;
    const gap = Math.max(0, AP_LOW - now, now - AP_HIGH);
    const damage = DAMAGE_WEIGHT * ((best / 0.1) ** 1.5 + (open ? 0.4 * (gap / 0.1) ** 1.2 : 0));

    // What the picks lean towards
    const sum = (k) => list.reduce((s, p) => s + p[k], 0);
    const lean = ARCH.map((k) => sum(k) / (n * AVG[k]));
    const total = lean.reduce((s, v) => s + v, 0) || 1;
    const sharp = lean.reduce((s, v) => s + v * v, 0) || 1;
    const share = lean.map((v) => (v * v) / sharp);
    const trust = Math.min(1, (n - 1) / 3);

    let needs = 0;
    const lacking = [];
    const floors = {};
    const sums = {};
    for (const k of Object.keys(WEIGHT)) {
      const plan = ARCH.reduce((s, a, i) => s + share[i] * (PLAN[a][k] ?? BASE[k]), 0);
      const floor = (1 - trust) * BASE[k] + trust * plan;
      if (floor <= 0) continue;
      floors[k] = floor;
      sums[k] = sum(k);
      const projected = sum(k) + open * (AVG[k] ?? 0);
      const short = Math.max(0, floor - projected) / floor;
      if (short > 0) {
        needs += WEIGHT[k] * short ** 1.5;
        if (short > 0.15) lacking.push(k);
      }
    }

    // Agreement: a team built around one plan has one dominant lean
    const dominant = Math.max(...lean) / total;
    const coherence = n >= 3 ? COHERENCE_WEIGHT * (Math.max(0, COHERENCE_FLOOR - dominant) / 0.1) ** 2 : 0;
    return { damage, needs, coherence, penalty: damage + needs + coherence, lacking, info: { n, open, share, dominant, floors, sums, ap: now } };
  }

  const PLAN_NAME = { pk: 'Poke / siege', en: 'Front-to-back teamfight', pe: 'Protect the carry', pi: 'Pick / catch', sp: 'Split push' };
  const NEED_NAME = { fr: 'Frontline', cc: 'Crowd control', en: 'Engage', wc: 'Waveclear', ac: 'Area control', pk: 'Long-range poke', pe: 'Peel', sc: 'Scaling', pi: 'Pick power', sp: 'Split pressure' };

  /**
   * What a team is turning into, for the draft screen: the plan its picks lean towards
   * (null while there are fewer than two picks), how sure that is, the traits the plan
   * needs with what the team has so far, and the damage split.
   * Returns { n, plan, label, confidence, mixed, plans: [{ key, name, share }], needs: [{ key, name, have, need, state }], damage: { ap, state } }
   * where a need's state is 'done', 'ontrack' (the picks to come can still reach it) or 'missing'.
   */
  function compProfile(team) {
    const fit = teamFit(team);
    const { n, open, share, dominant, floors, sums, ap } = fit.info || { n: 0, open: 5, share: ARCH.map(() => 0), dominant: 0, floors: {}, sums: {}, ap: 0.5 };
    const plans = ARCH.map((key, i) => ({ key, name: PLAN_NAME[key], share: share[i] || 0 })).sort((a, b) => b.share - a.share);
    const plan = n >= 2 ? plans[0].key : null;
    const mixed = n >= 4 && dominant < COHERENCE_FLOOR + 0.04;
    const needs = Object.keys(floors).map((key) => {
      const have = sums[key];
      const need = floors[key];
      const state = have >= need ? 'done' : have + open * (AVG[key] ?? 0) >= need ? 'ontrack' : 'missing';
      return { key, name: NEED_NAME[key], have: Math.round(have * 10) / 10, need: Math.round(need * 10) / 10, state };
    }).sort((a, b) => b.need - a.need);
    return {
      n,
      plan,
      label: !n ? 'Open draft' : !plan ? 'Taking shape' : mixed ? 'No clear plan' : PLAN_NAME[plan],
      confidence: plan ? plans[0].share : 0,
      mixed,
      plans,
      needs,
      damage: { ap, state: !n ? 'open' : ap > AP_HIGH ? 'ap-heavy' : ap < AP_LOW ? 'ad-heavy' : 'balanced' },
    };
  }

  const api = { traitsOf, pairBonus, teamFit, compProfile, KEYS, BY_ID, BY_NAME };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Traits = api;
})(typeof window !== 'undefined' ? window : globalThis);
