# Bengals Edge

A JavaScript web app for NFL player-prop research. Every team's QB/RB/WR/TE game logs this season with injury games excluded, each game compared to how good that defense is against the player's position, sportsbook lines with over/under calls for the next game, and a league-wide weekly picks list. Starts on the Bengals; pick any team from the header.

## Tabs

| Tab | What it shows |
|---|---|
| **Player log** | Every game per player: snaps, box score, target location (outside / middle / deep), aDOT, YAC, run direction, blitz rate faced. Stat switcher: receiving yds, receptions, rushing yds, scrimmage yds (plus passing yds for QBs). Chart shows actual vs the sportsbook line vs the model's expectation for each game. Injury games are struck through and left out. |
| **Next game** | Opponent's strengths and weaknesses, matchup factor by position, spread/total, and a props table: model projection, line (sportsbook or typed in), edge, how often he beat that line, and a call (Strong over / Lean over / Lean under / Far under). |
| **Weekly picks** | Across every team playing that week: plays against the line, plus the biggest matchup boosts and drops vs each player's own average. Tap a row to open the player. |
| **Defense ranks** | All 32 defenses on ~40 metrics. |
| **Ask Claude** | Chat button (bottom right, in the published Claude version). Claude can look up any player, defense, schedule or the weekly picks from the app's data to answer questions. Uses the viewer's own Claude usage. |

Hover (or tap on a phone) any column header for a short explanation of the stat.

## The model

1. Drop games where the player was hurt in-game (play-by-play injury notes, plus a snap-share collapse with a new injury on the next week's report).
2. Divide each remaining game by that opponent's factor for his position and stat (opponent's numbers exclude that game, and are shrunk toward average when the defense has played few games).
3. Average → "adjusted average" (vs a league-average defense).
4. Multiply by the next opponent's factor → model projection.
5. Compare to the line: Lean = 12%+ off the line and his clean-game history agrees; Strong/Far = 25%+.

## Data sources

- [nflverse-data releases](https://github.com/nflverse/nflverse-data/releases): play-by-play, weekly player stats, snap counts (PFR), injury reports, FTN charting, rosters, schedules with spread/total. Free, updated nightly.
- [The Odds API](https://the-odds-api.com/): player prop lines (consensus of US sportsbooks). Free plan = 500 credits/month; one pull of all games with the 5 prop markets ≈ 5 credits per game.

True pre-snap alignment (slot vs wide) isn't free in-season; throw location (outside vs middle) is the stand-in.

## Setup

1. Push this folder to a GitHub repo.
2. Settings → Pages → Source: **GitHub Actions**.
3. Run the **Update data** workflow once from the Actions tab.
4. Prop lines: sign up at the-odds-api.com, then Settings → Secrets and variables → Actions → New secret `ODDS_API_KEY`. The job pulls lines Thursday and Saturday and saves them in `data/lines_2026.json`, so past games keep their pre-game line for the over/under history.
   - Credit budget: ~16 games × 5 credits ≈ 80 per pull. Two pulls a week ≈ 640/month, over the free 500. Either drop the Thursday pull (edit the `DOW` check) or use the $30/month plan.
   - `--backfill-lines` fetches pre-game lines for games already played (historical odds cost more credits and need a paid plan).

Local run (Node 18+, no dependencies):

```bash
node scripts/build-data.mjs --season 2026            # stats only
ODDS_API_KEY=xxx node scripts/build-data.mjs --odds  # with prop lines
node scripts/bundle.mjs                              # builds public/index.html + dist/standalone.html
npx http-server public                               # view at localhost:8080
```

Lines typed into the app are saved in that browser only.

## Files

```
scripts/build-data.mjs   data pipeline (all teams, injury flags, defense profiles, prop lines)
scripts/bundle.mjs       builds public/index.html and dist/standalone.html from src/app.html
src/app.html             the app (HTML + CSS + JS)
public/data.json         generated data
data/lines_<season>.json saved sportsbook lines (grows each week)
.github/workflows/       scheduled refresh
```
