// Corvese Degen Command Center — secure ESPN private-league proxy v3.
// Required env vars: ESPN_S2, ESPN_SWID
// Optional env vars: DASHBOARD_ORIGIN (recommended), ALLOWED_LEAGUE_IDS (comma-separated)

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

const normalizeOrigin = value =>
  String(value || '').trim().replace(/\/$/, '');

const dashboardOrigin = normalizeOrigin(process.env.DASHBOARD_ORIGIN);

app.use(cors({
  origin(origin, callback) {
    if (
      !origin ||
      !dashboardOrigin ||
      normalizeOrigin(origin) === dashboardOrigin
    ) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed'));
  }
}));

app.get('/', (_req, res) =>
  res.json({
    ok: true,
    version: 3,
    service: 'Corvese Degen Command Center ESPN Proxy',
    endpoint: '/api/espn'
  })
);

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    version: 3
  })
);

function allowedLeague(leagueId) {
  const allowed = (process.env.ALLOWED_LEAGUE_IDS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  return !allowed.length || allowed.includes(String(leagueId));
}

async function espnGet(baseUrl, params) {
  const qs = new URLSearchParams();

  for (const [k, value] of Object.entries(params || {})) {
    if (Array.isArray(value)) {
      value.forEach(v => qs.append(k, String(v)));
    } else if (value !== undefined && value !== null) {
      qs.append(k, String(value));
    }
  }

  const upstream = await fetch(
    `${baseUrl}?${qs.toString()}`,
    {
      headers: {
        Cookie:
          `espn_s2=${process.env.ESPN_S2}; SWID=${process.env.ESPN_SWID}`,
        Accept: 'application/json, text/plain, */*',
        'User-Agent':
          'Mozilla/5.0 Corvese-Degen-Command-Center/1.3'
      }
    }
  );

  const text = await upstream.text();

  if (!upstream.ok) {
    const err = new Error(`ESPN upstream ${upstream.status}`);
    err.status = upstream.status;
    err.body = text.slice(0, 500);
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('ESPN returned non-JSON data');
  }
}

app.get('/api/espn', async (req, res) => {
  const {
    leagueId,
    season = '2026'
  } = req.query;

  if (
    !leagueId ||
    !/^\d+$/.test(String(leagueId))
  ) {
    return res.status(400).json({
      error: 'Valid numeric leagueId required'
    });
  }

  if (!/^\d{4}$/.test(String(season))) {
    return res.status(400).json({
      error: 'Valid four-digit season required'
    });
  }

  if (!allowedLeague(leagueId)) {
    return res.status(403).json({
      error: 'League not allowed by proxy configuration'
    });
  }

  if (!process.env.ESPN_S2 || !process.env.ESPN_SWID) {
    return res.status(500).json({
      error: 'ESPN credentials not configured on server'
    });
  }

  const base =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;

  try {

    // First request determines ESPN's current scoring
    // and matchup period and gets team metadata.

    const league = await espnGet(base, {
      view: [
        'mTeam',
        'mStatus',
        'mScoreboard'
      ]
    });

    const scoringPeriodId = Number(
      league.scoringPeriodId ??
      league.status?.currentScoringPeriod ??
      league.status?.currentScoringPeriodId ??
      league.status?.latestScoringPeriod
    ) || undefined;

    const matchupPeriodId = Number(
      league.status?.currentMatchupPeriod ??
      league.status?.currentMatchupPeriodId ??
      scoringPeriodId
    ) || undefined;

    // Explicitly request the current ESPN matchup.

    const matchup = await espnGet(base, {
      view: [
        'mTeam',
        'mMatchupScore',
        'mScoreboard'
      ],
      scoringPeriodId,
      matchupPeriodId
    });

    const merged = {
      ...league,
      ...matchup,

      teams:
        Array.isArray(matchup.teams) &&
        matchup.teams.length
          ? matchup.teams
          : league.teams,

      schedule:
        Array.isArray(matchup.schedule)
          ? matchup.schedule
          : league.schedule,

      scoringPeriodId:
        matchup.scoringPeriodId ??
        league.scoringPeriodId ??
        scoringPeriodId,

      status: {
        ...(league.status || {}),
        ...(matchup.status || {})
      },

      _dcc: {
        version: 3,
        scoringPeriodId,
        matchupPeriodId
      }
    };

    res.set('Cache-Control', 'no-store');

    return res.json(merged);

  } catch (error) {

    console.error(
      'ESPN upstream request failed:',
      error
    );

    return res
      .status(error.status || 502)
      .json({
        error:
          error.message ||
          'ESPN upstream request failed'
      });
  }
});

app.listen(
  PORT,
  '0.0.0.0',
  () =>
    console.log(
      `ESPN proxy v3 listening on port ${PORT}`
    )
);
