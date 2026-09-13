// Corvese Degen Command Center — secure ESPN private-league proxy.
// Required env vars: ESPN_S2, ESPN_SWID
// Optional env vars: DASHBOARD_ORIGIN (recommended), ALLOWED_LEAGUE_IDS (comma-separated)
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

const dashboardOrigin = (process.env.DASHBOARD_ORIGIN || '').trim();
app.use(cors({
  origin(origin, callback) {
    // Permit server-to-server/no-Origin probes, and the configured dashboard origin.
    if (!origin || !dashboardOrigin || origin === dashboardOrigin) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  }
}));

app.get('/', (_req, res) => res.json({
  ok: true,
  service: 'Corvese Degen Command Center ESPN Proxy',
  endpoint: '/api/espn'
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/espn', async (req, res) => {
  const { leagueId, season = '2026' } = req.query;
  if (!leagueId || !/^\d+$/.test(String(leagueId))) {
    return res.status(400).json({ error: 'Valid numeric leagueId required' });
  }
  if (!/^\d{4}$/.test(String(season))) {
    return res.status(400).json({ error: 'Valid four-digit season required' });
  }

  const allowed = (process.env.ALLOWED_LEAGUE_IDS || '')
    .split(',').map(x => x.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(leagueId))) {
    return res.status(403).json({ error: 'League not allowed by proxy configuration' });
  }

  if (!process.env.ESPN_S2 || !process.env.ESPN_SWID) {
    return res.status(500).json({ error: 'ESPN credentials not configured on server' });
  }

  const params = new URLSearchParams();
  ['mTeam', 'mRoster', 'mMatchup', 'mMatchupScore', 'mStatus'].forEach(v => params.append('view', v));
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?${params.toString()}`;

  try {
    const upstream = await fetch(url, {
      headers: {
        Cookie: `espn_s2=${process.env.ESPN_S2}; SWID=${process.env.ESPN_SWID}`,
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 Corvese-Degen-Command-Center/1.1'
      }
    });

    const body = await upstream.text();
    res.status(upstream.status);
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.set('Cache-Control', 'no-store');
    return res.send(body);
  } catch (error) {
    console.error('ESPN upstream request failed:', error);
    return res.status(502).json({ error: 'ESPN upstream request failed' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ESPN proxy listening on port ${PORT}`);
});
