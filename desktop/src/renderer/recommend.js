// Öneri motoru (geçici sürüm).
// Strateji aşamasında burası değişecek; arayüz sadece recommend() çıktısını kullanır:
//   [{ championId, role, score (0-100), reasons: string[] }]
//
// Şimdilik: oyuncunun havuzundaki konfor puanı + (varsa) meta puanı.

(function () {
  const COMFORT_WEIGHT = 0.6;
  const META_WEIGHT = 0.4;

  function metaLookup(meta) {
    const m = new Map();
    for (const row of meta || []) {
      if (row.score === null || row.score === undefined) continue;
      const key = `${row.champion_id}:${row.role}`;
      // Birden fazla kaynak varsa ortalamasını al
      const prev = m.get(key);
      m.set(key, prev ? { sum: prev.sum + Number(row.score), n: prev.n + 1 } : { sum: Number(row.score), n: 1 });
    }
    return (championId, role) => {
      const v = m.get(`${championId}:${role}`);
      return v ? v.sum / v.n : null;
    };
  }

  /**
   * @param {object} p
   * @param {Array<{champion_id:number, role:string, comfort:number}>} p.pool  oyuncunun havuzu
   * @param {string} p.role                rol (boşsa tüm havuz)
   * @param {Set<number>} p.unavailable    banlı / alınmış şampiyonlar
   * @param {Array} p.meta                 meta_scores satırları
   * @param {number} [p.limit]
   */
  function recommend({ pool, role, unavailable, meta, limit = 6 }) {
    const getMeta = metaLookup(meta);
    let candidates = pool.filter((e) => !role || e.role === role);
    if (!candidates.length) candidates = pool; // rolünde havuzu yoksa tüm havuzdan öner

    const best = new Map();
    for (const e of candidates) {
      if (unavailable.has(e.champion_id)) continue;
      const comfort = (e.comfort / 5) * 100;
      const m = getMeta(e.champion_id, role || e.role);
      const score = m === null ? comfort : COMFORT_WEIGHT * comfort + META_WEIGHT * m;
      const reasons = [`Konfor ${e.comfort}/5`];
      if (m !== null) reasons.push(`Meta ${Math.round(m)}`);
      if (role && e.role !== role) reasons.push('Rolü dışında');
      const item = { championId: e.champion_id, role: e.role, score: Math.round(score), reasons };
      const prev = best.get(e.champion_id);
      if (!prev || prev.score < item.score) best.set(e.champion_id, item);
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  window.Recommend = { recommend };
})();
