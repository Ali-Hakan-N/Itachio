// LCU'nun maç sonu (end-of-game) verisini sade bir sonuca çevirir.
// Alan adları LCU sürümleri arasında küçük farklar gösterebildiği için
// savunmacı yazıldı; ham veri ayrıca `raw` olarak saklanıyor.

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parseEndOfGame(block) {
  if (!block || !(block.gameId > 0)) return null;
  const lp = block.localPlayer || {};
  const st = lp.stats || {};
  const myTeam = (block.teams || []).find((t) => t.isPlayerTeam);

  let win = null;
  if (myTeam && typeof myTeam.isWinningTeam === 'boolean') win = myTeam.isWinningTeam;
  else if (st.WIN !== undefined) win = Number(st.WIN) === 1;
  else if (st.LOSE !== undefined) win = Number(st.LOSE) !== 1;

  const cs = (num(st.MINIONS_KILLED) || 0) + (num(st.NEUTRAL_MINIONS_KILLED) || 0);

  return {
    gameId: block.gameId,
    queueId: block.queueId ?? block.queueType ?? null,
    durationS: num(block.gameLength),
    championId: num(lp.championId),
    puuid: lp.puuid || null,
    win,
    kills: num(st.CHAMPIONS_KILLED),
    deaths: num(st.NUM_DEATHS),
    assists: num(st.ASSISTS),
    cs,
    gold: num(st.GOLD_EARNED),
    damage: num(st.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS),
    vision: num(st.VISION_SCORE),
    raw: block,
  };
}

module.exports = { parseEndOfGame };
