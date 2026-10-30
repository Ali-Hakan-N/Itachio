// Turns the LCU end-of-game data into a simple result.
// Written defensively because field names differ slightly between LCU versions;
// the raw data is also kept as `raw`.

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

/**
 * Every player of the game from the end-of-game data, for the summary:
 * [{ side: 'ally'|'enemy', championId, kills, deaths, assists, cs, gold, damage }]
 */
function parsePlayers(block) {
  const out = [];
  for (const team of block?.teams || []) {
    for (const p of team.players || []) {
      const st = p.stats || {};
      out.push({
        side: team.isPlayerTeam ? 'ally' : 'enemy',
        championId: num(p.championId),
        kills: num(st.CHAMPIONS_KILLED),
        deaths: num(st.NUM_DEATHS),
        assists: num(st.ASSISTS),
        cs: (num(st.MINIONS_KILLED) || 0) + (num(st.NEUTRAL_MINIONS_KILLED) || 0),
        gold: num(st.GOLD_EARNED),
        damage: num(st.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS),
      });
    }
  }
  return out;
}

module.exports = { parseEndOfGame, parsePlayers };
