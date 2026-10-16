#!/usr/bin/env node
// Bengals Edge — data pipeline (all 32 teams)
// Downloads public nflverse data (GitHub releases), builds every team's player game logs,
// flags in-game injuries, builds league-wide defensive profiles, merges sportsbook prop lines
// (The Odds API, optional), and writes public/data.json.
//
// Usage:  node scripts/build-data.mjs [--season 2026] [--cache ./.cache] [--odds] [--backfill-lines]
//   --odds            fetch current player prop lines (needs ODDS_API_KEY env var)
//   --backfill-lines  fetch pre-game lines for already-played games (The Odds API historical endpoint;
//                     costs ~10x credits, needs a plan that includes historical odds)
// Requires Node 18+. No npm dependencies.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
const SEASON = Number(opt('season') || process.env.SEASON || new Date().getFullYear());
const CACHE = opt('cache') ? resolve(opt('cache')) : null;
const OUT = resolve(opt('out') || join(ROOT, 'public', 'data.json'));
const LINES_FILE = join(ROOT, 'data', `lines_${SEASON}.json`);
const ODDS_KEY = process.env.ODDS_API_KEY || '';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const SOURCES = {
  pbp: `${BASE}/pbp/play_by_play_${SEASON}.csv.gz`,
  playerWeek: `${BASE}/stats_player/stats_player_week_${SEASON}.csv`,
  snaps: `${BASE}/snap_counts/snap_counts_${SEASON}.csv`,
  injuries: `${BASE}/injuries/injuries_${SEASON}.csv`,
  rosters: `${BASE}/rosters/roster_${SEASON}.csv`,
  ftn: `${BASE}/ftn_charting/ftn_charting_${SEASON}.csv`,
  games: `${BASE}/schedules/games.csv`,
  teams: `${BASE}/teams/teams_colors_logos.csv`,
};

// ---------- helpers ----------
async function getText(key) {
  const url = SOURCES[key]; const file = url.split('/').pop();
  let buf;
  if (CACHE && existsSync(join(CACHE, file))) buf = readFileSync(join(CACHE, file));
  else {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${key}: HTTP ${res.status} for ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  return file.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
}
function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.filter(r => r.length > 1).map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i] ?? ''; }); return o; });
}
const num = v => (v === '' || v === 'NA' || v == null ? null : Number(v));
const n0 = v => num(v) ?? 0;
const r = (v, d = 1) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const div = (a, b) => (b ? a / b : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const normName = s => String(s).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };

// ---------- load ----------
console.log(`Building ${SEASON} (all teams)…`);
const [pbpT, pwT, snT, injT, rosT, gamesT, teamsT] = await Promise.all(
  ['pbp', 'playerWeek', 'snaps', 'injuries', 'rosters', 'games', 'teams'].map(getText));
let ftnT = '';
try { ftnT = await getText('ftn'); } catch (e) { console.warn('FTN charting unavailable:', e.message); }

const pbp = parseCSV(pbpT).filter(p => p.season_type === 'REG' || p.season_type === 'POST');
const playerWeek = parseCSV(pwT);
const snaps = parseCSV(snT);
const injuries = parseCSV(injT);
const rosters = parseCSV(rosT);
const games = parseCSV(gamesT).filter(g => Number(g.season) === SEASON);
const teamsCsv = parseCSV(teamsT);
const ftn = ftnT ? parseCSV(ftnT) : [];
console.log(`pbp ${pbp.length} · player-weeks ${playerWeek.length} · snaps ${snaps.length} · ftn ${ftn.length}`);

// ---------- lookups ----------
const posById = new Map();
for (const p of playerWeek) if (p.player_id && p.position) posById.set(p.player_id, p.position);
for (const p of rosters) if (p.gsis_id && !posById.has(p.gsis_id)) posById.set(p.gsis_id, p.position);
const posGroup = id => { const p = posById.get(id); if (!p) return null; if (p === 'FB') return 'RB'; return ['QB', 'RB', 'WR', 'TE'].includes(p) ? p : null; };
const ftnByPlay = new Map(ftn.map(f => [`${f.nflverse_game_id}|${f.nflverse_play_id}`, f]));

const finished = games.filter(g => g.home_score !== '' && g.away_score !== '');
const pointsAllowed = {};
for (const g of finished) {
  (pointsAllowed[g.home_team] ||= {})[g.game_id] = Number(g.away_score);
  (pointsAllowed[g.away_team] ||= {})[g.game_id] = Number(g.home_score);
}

// ---------- defensive accumulation (per defense, per game) ----------
const isPlay = p => (p.play_type === 'pass' || p.play_type === 'run') && p.two_point_attempt !== '1'
  && p.qb_kneel !== '1' && p.qb_spike !== '1' && p.epa !== '' && p.epa !== 'NA';
const plays = pbp.filter(isPlay);
const defAcc = {};
const bump = (o, k, v = 1) => { o[k] = (o[k] || 0) + v; };
for (const p of plays) {
  const d = ((defAcc[p.defteam] ||= {})[p.game_id] ||= {});
  const epa = n0(p.epa), yds = n0(p.yards_gained), succ = n0(p.success);
  bump(d, 'plays'); bump(d, 'epa', epa); bump(d, 'succ', succ);
  const db = p.qb_dropback === '1';
  const rush = p.play_type === 'run' && p.qb_scramble !== '1';
  const f = ftnByPlay.get(`${p.game_id}|${p.play_id}`);
  if (db) {
    bump(d, 'db'); bump(d, 'db_epa', epa);
    if (p.sack === '1') bump(d, 'sacks');
    if (f) { bump(d, 'ftn_db'); if (n0(f.n_blitzers) > 0) bump(d, 'blitz'); bump(d, 'rushers', n0(f.n_pass_rushers)); }
  }
  if (p.play_type === 'run' && posGroup(p.rusher_player_id) === 'QB') bump(d, 'QB_ryds', yds);
  if (p.pass_attempt === '1' && p.sack !== '1' && p.play_type === 'pass') {
    bump(d, 'att'); if (p.complete_pass === '1') { bump(d, 'cmp'); bump(d, 'pass_yds', yds); }
    if (p.interception === '1') bump(d, 'ints');
    if (num(p.cpoe) != null) { bump(d, 'cpoe', num(p.cpoe)); bump(d, 'cpoe_n'); }
    if (p.complete_pass === '1' && yds >= 20) bump(d, 'exp_pass');
    const pg = posGroup(p.receiver_player_id);
    if (pg && pg !== 'QB') {
      bump(d, `${pg}_tgt`); bump(d, `${pg}_epa`, epa);
      if (p.complete_pass === '1') { bump(d, `${pg}_rec`); bump(d, `${pg}_yds`, yds); }
      if (p.pass_touchdown === '1') bump(d, `${pg}_td`);
      if (pg === 'WR' && p.pass_location) {
        const loc = p.pass_location === 'middle' ? 'mid' : 'out';
        bump(d, `wr_${loc}_tgt`); if (p.complete_pass === '1') bump(d, `wr_${loc}_yds`, yds);
      }
    }
    if (n0(p.air_yards) >= 20) { bump(d, 'deep_tgt'); bump(d, 'deep_epa', epa); if (p.complete_pass === '1') bump(d, 'deep_yds', yds); }
  }
  if (rush) {
    bump(d, 'rush'); bump(d, 'rush_epa', epa); bump(d, 'rush_yds', yds);
    if (yds <= 0) bump(d, 'stuffs'); if (yds >= 10) bump(d, 'exp_rush');
    if (f && num(f.n_defense_box) != null) { bump(d, 'box', num(f.n_defense_box)); bump(d, 'box_n'); }
    if (posGroup(p.rusher_player_id) === 'RB') { bump(d, 'RB_car'); bump(d, 'RB_ryds', yds); }
  }
}

// dir: +1 higher = better defense, -1 lower = better defense, 0 informational
const METRICS = [
  { k: 'pts_g', label: 'Points allowed / game', grp: 'Overall', dir: -1, d: 1, f: (s, g, pa) => div(pa, g) },
  { k: 'epa_play', label: 'EPA / play allowed', grp: 'Overall', dir: -1, d: 3, f: s => div(s.epa, s.plays) },
  { k: 'succ', label: 'Success rate allowed', grp: 'Overall', dir: -1, d: 3, pct: 1, f: s => div(s.succ, s.plays) },
  { k: 'pass_epa', label: 'EPA / dropback', grp: 'Pass D', dir: -1, d: 3, f: s => div(s.db_epa, s.db) },
  { k: 'pass_yds_g', label: 'Pass yds / game', grp: 'Pass D', dir: -1, d: 1, f: (s, g) => div(s.pass_yds, g) },
  { k: 'ypa', label: 'Yards / attempt', grp: 'Pass D', dir: -1, d: 2, f: s => div(s.pass_yds, s.att) },
  { k: 'cmp_pct', label: 'Completion %', grp: 'Pass D', dir: -1, d: 3, pct: 1, f: s => div(s.cmp, s.att) },
  { k: 'cpoe', label: 'CPOE allowed', grp: 'Pass D', dir: -1, d: 1, f: s => div(s.cpoe, s.cpoe_n) },
  { k: 'sack_rate', label: 'Sack rate', grp: 'Pass D', dir: 1, d: 3, pct: 1, f: s => div(s.sacks, s.db) },
  { k: 'int_rate', label: 'INT rate', grp: 'Pass D', dir: 1, d: 3, pct: 1, f: s => div(s.ints, s.att) },
  { k: 'exp_pass', label: '20+ yd completions %', grp: 'Pass D', dir: -1, d: 3, pct: 1, f: s => div(s.exp_pass, s.att) },
  { k: 'blitz', label: 'Blitz rate', grp: 'Pass D', dir: 0, d: 3, pct: 1, f: s => div(s.blitz, s.ftn_db) },
  { k: 'rushers', label: 'Avg pass rushers', grp: 'Pass D', dir: 0, d: 2, f: s => div(s.rushers, s.ftn_db) },
  { k: 'qb_rush_g', label: 'QB rush yds / game', grp: 'Pass D', dir: -1, d: 1, f: (s, g) => div(s.QB_ryds || 0, g) },
  { k: 'rush_epa', label: 'EPA / rush', grp: 'Run D', dir: -1, d: 3, f: s => div(s.rush_epa, s.rush) },
  { k: 'rush_yds_g', label: 'Rush yds / game', grp: 'Run D', dir: -1, d: 1, f: (s, g) => div(s.rush_yds, g) },
  { k: 'ypc', label: 'Yards / carry', grp: 'Run D', dir: -1, d: 2, f: s => div(s.rush_yds, s.rush) },
  { k: 'stuff', label: 'Stuff rate (≤0 yds)', grp: 'Run D', dir: 1, d: 3, pct: 1, f: s => div(s.stuffs, s.rush) },
  { k: 'exp_rush', label: '10+ yd run rate', grp: 'Run D', dir: -1, d: 3, pct: 1, f: s => div(s.exp_rush, s.rush) },
  { k: 'box', label: 'Avg men in box', grp: 'Run D', dir: 0, d: 2, f: s => div(s.box, s.box_n) },
  { k: 'wr_yds_g', label: 'WR rec yds / game', grp: 'vs WR', dir: -1, d: 1, f: (s, g) => div(s.WR_yds || 0, g) },
  { k: 'wr_rec_g', label: 'WR receptions / game', grp: 'vs WR', dir: -1, d: 2, f: (s, g) => div(s.WR_rec || 0, g) },
  { k: 'wr_tgt_g', label: 'WR targets / game', grp: 'vs WR', dir: 0, d: 1, f: (s, g) => div(s.WR_tgt || 0, g) },
  { k: 'wr_ypt', label: 'WR yds / target', grp: 'vs WR', dir: -1, d: 2, f: s => div(s.WR_yds, s.WR_tgt) },
  { k: 'wr_epa', label: 'WR EPA / target', grp: 'vs WR', dir: -1, d: 3, f: s => div(s.WR_epa, s.WR_tgt) },
  { k: 'wr_td_g', label: 'WR TDs / game', grp: 'vs WR', dir: -1, d: 2, f: (s, g) => div(s.WR_td || 0, g) },
  { k: 'wr_out_ypt', label: 'WR yds/tgt — outside', grp: 'vs WR', dir: -1, d: 2, f: s => div(s.wr_out_yds, s.wr_out_tgt) },
  { k: 'wr_mid_ypt', label: 'WR yds/tgt — middle', grp: 'vs WR', dir: -1, d: 2, f: s => div(s.wr_mid_yds, s.wr_mid_tgt) },
  { k: 'deep_yds_g', label: 'Deep (20+ air) yds / game', grp: 'vs WR', dir: -1, d: 1, f: (s, g) => div(s.deep_yds || 0, g) },
  { k: 'te_yds_g', label: 'TE rec yds / game', grp: 'vs TE', dir: -1, d: 1, f: (s, g) => div(s.TE_yds || 0, g) },
  { k: 'te_rec_g', label: 'TE receptions / game', grp: 'vs TE', dir: -1, d: 2, f: (s, g) => div(s.TE_rec || 0, g) },
  { k: 'te_ypt', label: 'TE yds / target', grp: 'vs TE', dir: -1, d: 2, f: s => div(s.TE_yds, s.TE_tgt) },
  { k: 'te_epa', label: 'TE EPA / target', grp: 'vs TE', dir: -1, d: 3, f: s => div(s.TE_epa, s.TE_tgt) },
  { k: 'te_td_g', label: 'TE TDs / game', grp: 'vs TE', dir: -1, d: 2, f: (s, g) => div(s.TE_td || 0, g) },
  { k: 'rb_scrim_g', label: 'RB scrimmage yds / game', grp: 'vs RB', dir: -1, d: 1, f: (s, g) => div((s.RB_ryds || 0) + (s.RB_yds || 0), g) },
  { k: 'rb_rush_g', label: 'RB rush yds / game', grp: 'vs RB', dir: -1, d: 1, f: (s, g) => div(s.RB_ryds || 0, g) },
  { k: 'rb_ypc', label: 'RB yards / carry', grp: 'vs RB', dir: -1, d: 2, f: s => div(s.RB_ryds, s.RB_car) },
  { k: 'rb_rec_g', label: 'RB rec yds / game', grp: 'vs RB', dir: -1, d: 1, f: (s, g) => div(s.RB_yds || 0, g) },
  { k: 'rb_recs_g', label: 'RB receptions / game', grp: 'vs RB', dir: -1, d: 2, f: (s, g) => div(s.RB_rec || 0, g) },
];
const POS_METRICS = {
  QB: ['pass_epa', 'pass_yds_g', 'sack_rate', 'blitz', 'qb_rush_g'],
  RB: ['rb_rush_g', 'rb_ypc', 'rb_rec_g', 'stuff', 'box'],
  WR: ['wr_yds_g', 'wr_rec_g', 'wr_out_ypt', 'wr_mid_ypt', 'deep_yds_g'],
  TE: ['te_yds_g', 'te_rec_g', 'te_ypt', 'wr_mid_ypt'],
};
// Which defensive metric scales each stat, by position
const STAT_FACTOR = {
  pass_yds: { QB: 'pass_yds_g' },
  rec_yds: { RB: 'rb_rec_g', WR: 'wr_yds_g', TE: 'te_yds_g' },
  rec: { RB: 'rb_recs_g', WR: 'wr_rec_g', TE: 'te_rec_g' },
  rush_yds: { QB: 'qb_rush_g', RB: 'rb_rush_g', WR: 'rush_yds_g', TE: 'rush_yds_g' },
  scrim_yds: { QB: 'qb_rush_g', RB: 'rb_scrim_g', WR: 'wr_yds_g', TE: 'te_yds_g' },
};

function profile(def, excludeGids = []) {
  const ex = new Set(excludeGids); const s = {}; let g = 0, pa = 0;
  for (const [gid, sums] of Object.entries(defAcc[def] || {})) {
    if (ex.has(gid)) continue; g++; pa += pointsAllowed[def]?.[gid] ?? 0;
    for (const [k, v] of Object.entries(sums)) s[k] = (s[k] || 0) + v;
  }
  const out = { games: g };
  for (const m of METRICS) out[m.k] = g ? r(m.f(s, g, pa), m.d) : null;
  return out;
}
const TEAMS = Object.keys(defAcc).sort();
const defenses = Object.fromEntries(TEAMS.map(t => [t, profile(t)]));
const league = {};
for (const m of METRICS) {
  const vals = TEAMS.map(t => defenses[t][m.k]).filter(v => v != null);
  league[m.k] = r(vals.reduce((a, b) => a + b, 0) / (vals.length || 1), 4);
  TEAMS.filter(t => defenses[t][m.k] != null)
    .sort((a, b) => (m.dir >= 0 ? defenses[b][m.k] - defenses[a][m.k] : defenses[a][m.k] - defenses[b][m.k]))
    .forEach((t, i) => { (defenses[t].rank ||= {})[m.k] = i + 1; });
}

// ---------- teams ----------
const teamsInfo = {};
for (const t of teamsCsv) if (TEAMS.includes(t.team_abbr) || games.some(g => g.home_team === t.team_abbr))
  teamsInfo[t.team_abbr] = { name: t.team_name, nick: t.team_nick, conf: t.team_conf, div: t.team_division, c1: t.team_color, c2: t.team_color2 };

const rosterByTeam = groupBy(rosters, p => p.team);
const statsByTeam = groupBy(playerWeek.filter(p => ['QB', 'RB', 'FB', 'WR', 'TE'].includes(p.position)), p => p.team);
const snapsByGame = groupBy(snaps, s => s.game_id);
const pbpByGame = groupBy(pbp, p => p.game_id);
const injByPlayer = groupBy(injuries, i => i.gsis_id);

function buildTeam(T) {
  const tGames = games.filter(g => g.home_team === T || g.away_team === T)
    .sort((a, b) => Number(a.week) - Number(b.week) || a.gameday.localeCompare(b.gameday));
  const info = g => {
    const home = g.home_team === T; const opp = home ? g.away_team : g.home_team;
    const done = g.home_score !== '' && g.away_score !== '';
    const us = done ? Number(home ? g.home_score : g.away_score) : null, them = done ? Number(home ? g.away_score : g.home_score) : null;
    return { gid: g.game_id, week: Number(g.week), date: g.gameday, time: g.gametime, opp, home, neutral: g.location === 'Neutral', done,
      us, them, result: done ? (us > them ? 'W' : us < them ? 'L' : 'T') : null, spread: num(g.spread_line), total: num(g.total_line) };
  };
  const played = tGames.map(info).filter(g => g.done && pbpByGame.has(g.gid));
  const upcoming = tGames.map(info).filter(g => !g.done);
  for (const g of played) g.oppProf = profile(g.opp, [g.gid]);

  const roster = new Map((rosterByTeam.get(T) || []).map(p => [p.gsis_id, p]));
  const jerseyToId = new Map([...roster.values()].map(p => [p.jersey_number, p.gsis_id]));
  const pfrToId = new Map([...roster.values()].filter(p => p.pfr_id).map(p => [p.pfr_id, p.gsis_id]));
  const statRows = statsByTeam.get(T) || [];
  const ids = [...new Set(statRows.map(p => p.player_id))];
  for (const g of played) for (const s of snapsByGame.get(g.gid) || [])
    if (s.team === T && n0(s.offense_snaps) > 0 && ['QB', 'RB', 'HB', 'FB', 'WR', 'TE'].includes(s.position)) {
      const id = pfrToId.get(s.pfr_player_id); if (id && !ids.includes(id)) ids.push(id);
    }

  // In-game injuries from play-by-play text
  const injured = {};
  const nameOf = id => roster.get(id)?.full_name || statRows.find(s => s.player_id === id)?.player_display_name || '';
  const lastOf = id => roster.get(id)?.last_name || nameOf(id).split(' ').slice(1).join(' ');
  for (const g of played) for (const p of pbpByGame.get(g.gid) || []) {
    if (!p.desc.includes('injur')) continue;
    for (const m of p.desc.matchAll(/([A-Z][a-z]?)\.([A-Z][A-Za-z'\-. ]+?) was injured/g)) {
      if (p.posteam !== T && p.defteam !== T) continue;
      for (const id of ids) if (normName(lastOf(id)) === normName(m[2]) && nameOf(id).startsWith(m[1][0]))
        (injured[id] ||= {})[g.gid] = `Injured in-game (Q${p.qtr} ${p.time})`;
    }
    for (const m of p.desc.matchAll(new RegExp(`Injury Update: ${T}-(\\d+)-`, 'g'))) {
      const id = jerseyToId.get(m[1]); if (id && ids.includes(id)) (injured[id] ||= {})[g.gid] ||= `Injury update (Q${p.qtr} ${p.time})`;
    }
  }

  const players = [];
  for (const id of ids) {
    const ro = roster.get(id); const rows = statRows.filter(s => s.player_id === id);
    const name = ro?.full_name || rows[0]?.player_display_name || id;
    const pos = (rows[0]?.position || ro?.position || '').replace('FB', 'RB').replace('HB', 'RB');
    if (!['QB', 'RB', 'WR', 'TE'].includes(pos)) continue;
    const pfr = ro?.pfr_id; const gl = [];
    for (const g of played) {
      const st = rows.find(s => s.game_id === g.gid) || rows.find(s => Number(s.week) === g.week && s.opponent_team === g.opp);
      const sn = (snapsByGame.get(g.gid) || []).find(s => s.team === T && ((pfr && s.pfr_player_id === pfr) || normName(s.player) === normName(name)));
      const snapsN = sn ? n0(sn.offense_snaps) : 0;
      if (!st && !snapsN) continue;
      const v = k => (st ? num(st[k]) ?? 0 : 0);
      const my = (pbpByGame.get(g.gid) || []).filter(isPlay);
      const tg = my.filter(p => p.receiver_player_id === id && p.play_type === 'pass' && p.sack !== '1');
      const sp = arr => [arr.length, arr.reduce((a, p) => a + (p.complete_pass === '1' ? n0(p.yards_gained) : 0), 0)];
      const ru = my.filter(p => p.rusher_player_id === id && p.play_type === 'run' && p.qb_scramble !== '1');
      const pa = my.filter(p => p.passer_player_id === id && p.qb_dropback === '1').map(p => ftnByPlay.get(`${p.game_id}|${p.play_id}`)).filter(Boolean);
      const rd = loc => { const a = ru.filter(p => loc === 'm' ? p.run_location === 'middle' : (p.run_location === 'left' || p.run_location === 'right')); return [a.length, a.reduce((s, p) => s + n0(p.yards_gained), 0)]; };
      const ay = tg.filter(p => num(p.air_yards) != null);
      gl.push({
        gid: g.gid, w: g.week, sn: snapsN, sp: sn ? r(n0(sn.offense_pct), 2) : null,
        s: { cmp: v('completions'), att: v('attempts'), pyd: v('passing_yards'), ptd: v('passing_tds'), int: v('passing_interceptions'), sk: v('sacks_suffered'),
          pepa: r(v('passing_epa'), 1), cpoe: r(v('passing_cpoe'), 1), car: v('carries'), ryd: v('rushing_yards'), rtd: v('rushing_tds'),
          tgt: v('targets'), rec: v('receptions'), yds: v('receiving_yards'), td: v('receiving_tds'), yac: v('receiving_yards_after_catch'),
          ts: r(v('target_share'), 3) },
        x: { out: sp(tg.filter(p => p.pass_location === 'left' || p.pass_location === 'right')), mid: sp(tg.filter(p => p.pass_location === 'middle')),
          deep: sp(tg.filter(p => n0(p.air_yards) >= 20)), adot: ay.length ? r(ay.reduce((a, p) => a + n0(p.air_yards), 0) / ay.length, 1) : null,
          rin: rd('m'), rout: rd('e'), rsucc: ru.length ? r(ru.reduce((a, p) => a + n0(p.success), 0) / ru.length, 2) : null,
          blz: pa.length ? r(pa.filter(f => n0(f.n_blitzers) > 0).length / pa.length, 2) : null,
          pa: pa.length ? r(pa.filter(f => f.is_play_action === 'TRUE' || f.is_play_action === '1').length / pa.length, 2) : null },
        inj: injured[id]?.[g.gid] ? { lv: 'confirmed', note: injured[id][g.gid] } : null,
      });
    }
    if (!gl.length) continue;
    const ih = injByPlayer.get(id) || [];
    const med = median(gl.filter(x => !x.inj && x.sp != null).map(x => x.sp));
    for (const gm of gl) {
      if (gm.inj || med == null || gm.sp == null) continue;
      const injOn = w => { const i = ih.find(i => Number(i.week) === w); return i && (i.report_primary_injury || i.practice_primary_injury); };
      const nx = injOn(gm.w + 1), pv = injOn(gm.w);
      if (nx && nx !== pv && gm.sp < med * 0.6) gm.inj = { lv: 'likely', note: `Snap share fell to ${Math.round(gm.sp * 100)}%; on Wk ${gm.w + 1} report (${nx})` };
    }
    const report = ih.filter(i => i.report_primary_injury || i.practice_primary_injury || i.report_status)
      .map(i => ({ w: Number(i.week), inj: i.report_primary_injury || i.practice_primary_injury || '', st: i.report_status || '', pr: i.practice_status || '' }));
    players.push({ id, name, pos, jersey: ro?.jersey_number || '', games: gl, report });
  }
  const po = { QB: 0, RB: 1, WR: 2, TE: 3 };
  const totSnaps = p => p.games.reduce((s, g) => s + g.sn, 0);
  players.sort((a, b) => po[a.pos] - po[b.pos] || totSnaps(b) - totSnaps(a));
  return { played, upcoming, players };
}
const teams = {};
for (const T of Object.keys(teamsInfo).sort()) teams[T] = buildTeam(T);

// ---------- sportsbook lines (The Odds API) ----------
const MARKETS = { player_pass_yds: 'pass_yds', player_reception_yds: 'rec_yds', player_receptions: 'rec', player_rush_yds: 'rush_yds', player_rush_reception_yds: 'scrim_yds' };
let lines = existsSync(LINES_FILE) ? JSON.parse(readFileSync(LINES_FILE, 'utf8')) : { games: {} };
const nameToTeam = Object.fromEntries(Object.entries(teamsInfo).map(([a, t]) => [t.name, a]));
const playerIndex = T => new Map(teams[T].players.map(p => [normName(p.name), p.id]));

function parseProps(oddsJson, gid, home, away) {
  const out = {}; const idx = new Map([...playerIndex(home), ...playerIndex(away)]);
  const agg = {};
  for (const bk of oddsJson.bookmakers || []) for (const mk of bk.markets || []) {
    const stat = MARKETS[mk.key]; if (!stat) continue;
    for (const o of mk.outcomes || []) {
      if (o.point == null || !o.description) continue;
      const id = idx.get(normName(o.description)); if (!id) continue;
      const a = ((agg[id] ||= {})[stat] ||= { pts: [], over: [], under: [], books: new Set() });
      if (o.name === 'Over') { a.pts.push(o.point); a.over.push(o.price); } else if (o.name === 'Under') a.under.push(o.price);
      a.books.add(bk.key);
    }
  }
  for (const [id, st] of Object.entries(agg)) for (const [stat, a] of Object.entries(st)) if (a.pts.length)
    (out[id] ||= {})[stat] = { line: median(a.pts), over: median(a.over), under: median(a.under), books: a.books.size };
  return out;
}
async function oddsGet(path, params) {
  const u = new URL(`https://api.the-odds-api.com/v4${path}`);
  u.searchParams.set('apiKey', ODDS_KEY);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  const res = await fetch(u);
  if (!res.ok) throw new Error(`Odds API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.log(`  odds credits remaining: ${res.headers.get('x-requests-remaining')}`);
  return res.json();
}
const gidFor = (home, away, iso) => {
  const day = iso.slice(0, 10);
  const g = games.find(x => x.home_team === home && x.away_team === away && Math.abs(new Date(x.gameday) - new Date(day)) <= 2 * 864e5);
  return g?.game_id;
};
const oddsParams = { regions: 'us', markets: Object.keys(MARKETS).join(','), oddsFormat: 'american' };

if (flag('odds')) {
  if (!ODDS_KEY) console.warn('--odds given but ODDS_API_KEY is not set; skipping line fetch.');
  else {
    console.log('Fetching current prop lines…');
    const events = await oddsGet('/sports/americanfootball_nfl/events');
    const now = Date.now(), horizon = now + 8 * 864e5;
    for (const ev of events) {
      const t = new Date(ev.commence_time).getTime(); if (t < now || t > horizon) continue;
      const home = nameToTeam[ev.home_team], away = nameToTeam[ev.away_team]; if (!home || !away) continue;
      const gid = gidFor(home, away, ev.commence_time); if (!gid) continue;
      try {
        const od = await oddsGet(`/sports/americanfootball_nfl/events/${ev.id}/odds`, oddsParams);
        lines.games[gid] = { fetched: new Date().toISOString(), kickoff: ev.commence_time, players: parseProps(od, gid, home, away) };
        console.log(`  ${gid}: ${Object.keys(lines.games[gid].players).length} players with lines`);
      } catch (e) { console.warn(`  ${gid}: ${e.message}`); }
    }
  }
}
if (flag('backfill-lines') && ODDS_KEY) {
  console.log('Backfilling pre-game lines for played games…');
  for (const g of finished) {
    if (lines.games[g.game_id]) continue;
    const kick = new Date(`${g.gameday}T${g.gametime || '13:00'}:00-04:00`); const snap = new Date(kick.getTime() - 2 * 36e5).toISOString().replace(/\.\d+Z$/, 'Z');
    try {
      const evs = await oddsGet('/historical/sports/americanfootball_nfl/events', { date: snap });
      const ev = (evs.data || []).find(e => nameToTeam[e.home_team] === g.home_team && nameToTeam[e.away_team] === g.away_team);
      if (!ev) continue;
      const od = await oddsGet(`/historical/sports/americanfootball_nfl/events/${ev.id}/odds`, { ...oddsParams, date: snap });
      lines.games[g.game_id] = { fetched: snap, kickoff: ev.commence_time, players: parseProps(od.data || {}, g.game_id, g.home_team, g.away_team), historical: true };
      console.log(`  ${g.game_id}: ${Object.keys(lines.games[g.game_id].players).length} players`);
    } catch (e) { console.warn(`  ${g.game_id}: ${e.message}`); break; }
  }
}
mkdirSync(dirname(LINES_FILE), { recursive: true });
writeFileSync(LINES_FILE, JSON.stringify(lines, null, 1));

// ---------- write ----------
const data = {
  meta: {
    season: SEASON, generated: new Date().toISOString(), lastWeekWithPbp: Math.max(...pbp.map(p => Number(p.week))),
    linesSource: Object.keys(lines.games).length ? 'The Odds API (consensus of US books)' : null,
    sources: [
      { name: 'nflverse play-by-play (nflfastR)', url: 'https://github.com/nflverse/nflverse-data/releases/tag/pbp' },
      { name: 'nflverse weekly player stats', url: 'https://github.com/nflverse/nflverse-data/releases/tag/stats_player' },
      { name: 'Snap counts (Pro Football Reference via nflverse)', url: 'https://github.com/nflverse/nflverse-data/releases/tag/snap_counts' },
      { name: 'Official injury reports (via nflverse)', url: 'https://github.com/nflverse/nflverse-data/releases/tag/injuries' },
      { name: 'FTN charting', url: 'https://github.com/nflverse/nflverse-data/releases/tag/ftn_charting' },
      { name: 'Prop lines: The Odds API', url: 'https://the-odds-api.com/' },
    ],
  },
  metrics: METRICS.map(({ k, label, grp, dir, pct }) => ({ k, label, grp, dir, pct: !!pct })),
  posMetrics: POS_METRICS, statFactor: STAT_FACTOR, league, defenses, teamsInfo, teams,
  lines: Object.fromEntries(Object.entries(lines.games).map(([gid, v]) => [gid, v.players])),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(data));
const nPlayers = Object.values(teams).reduce((s, t) => s + t.players.length, 0);
const nInj = Object.values(teams).reduce((s, t) => s + t.players.reduce((a, p) => a + p.games.filter(g => g.inj).length, 0), 0);
console.log(`Wrote ${OUT} (${(JSON.stringify(data).length / 1e6).toFixed(2)} MB) — ${Object.keys(teams).length} teams, ${nPlayers} players, ${nInj} injury-excluded games, lines for ${Object.keys(lines.games).length} games`);
