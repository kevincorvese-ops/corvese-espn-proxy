// Corvese Degen Command Center — secure ESPN/FanDuel helper proxy v9.
// Required env vars for private ESPN fantasy leagues: ESPN_S2, ESPN_SWID
// Optional env vars: DASHBOARD_ORIGIN, ALLOWED_LEAGUE_IDS
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '12mb' }));
const PORT = process.env.PORT || 10000;
const normalizeOrigin = value => String(value || '').trim().replace(/\/$/, '');
const dashboardOrigin = normalizeOrigin(process.env.DASHBOARD_ORIGIN);

app.use(cors({
  origin(origin, callback) {
    if (!origin || !dashboardOrigin || normalizeOrigin(origin) === dashboardOrigin) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  }
}));

app.get('/', (_req, res) => res.json({
  ok: true,
  version: 9,
  service: 'Corvese Degen Command Center Proxy',
  endpoints: ['/api/espn', '/api/nfl/scoreboard', '/api/fanduel', '/api/bet/recognize', '/api/bets', '/api/config']
}));

app.get('/health', (_req, res) => res.json({ ok: true, version: 9 }));

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
    if (Array.isArray(value)) value.forEach(v => qs.append(k, String(v)));
    else if (value !== undefined && value !== null) qs.append(k, String(value));
  }

  const upstream = await fetch(`${baseUrl}?${qs.toString()}`, {
    headers: {
      Cookie: `espn_s2=${process.env.ESPN_S2}; SWID=${process.env.ESPN_SWID}`,
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 Corvese-Degen-Command-Center/1.7'
    }
  });

  const text = await upstream.text();

  if (!upstream.ok) {
    const err = new Error(`ESPN upstream ${upstream.status}`);
    err.status = upstream.status;
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('ESPN returned non-JSON data');
  }
}

app.get('/api/espn', async (req, res) => {
  const { leagueId, season = '2026' } = req.query;

  if (!leagueId || !/^\d+$/.test(String(leagueId))) {
    return res.status(400).json({ error: 'Valid numeric leagueId required' });
  }

  if (!/^\d{4}$/.test(String(season))) {
    return res.status(400).json({ error: 'Valid four-digit season required' });
  }

  if (!allowedLeague(leagueId)) {
    return res.status(403).json({ error: 'League not allowed by proxy configuration' });
  }

  if (!process.env.ESPN_S2 || !process.env.ESPN_SWID) {
    return res.status(500).json({ error: 'ESPN credentials not configured on server' });
  }

  const base =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;

  try {
    const league = await espnGet(base, {
      view: ['mTeam', 'mStatus', 'mScoreboard']
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

    const matchup = await espnGet(base, {
      view: [
        'mTeam',
        'mRoster',
        'mLiveScoring',
        'mMatchup',
        'mMatchupScore',
        'mScoreboard',
        'mBoxscore',
        'proTeamSchedules_wl'
      ],
      scoringPeriodId,
      matchupPeriodId
    });

    const merged = {
      ...league,
      ...matchup,
      teams:
        Array.isArray(matchup.teams) && matchup.teams.length
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
        version: 9,
        scoringPeriodId,
        matchupPeriodId
      }
    };

    res.set('Cache-Control', 'no-store');
    return res.json(merged);

  } catch (error) {
    console.error('ESPN fantasy upstream request failed:', error);

    return res
      .status(error.status || 502)
      .json({ error: error.message || 'ESPN upstream request failed' });
  }
});


// -------------------------------------------------------
// NFL SCOREBOARD
// -------------------------------------------------------

app.get('/api/nfl/scoreboard', async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();

    const valid = v => /^\d{8}$/.test(v);

    if ((from && !valid(from)) || (to && !valid(to))) {
      return res.status(400).json({ error: 'Dates must be YYYYMMDD.' });
    }

    const dates = from && to ? `${from}-${to}` : (from || to || '');

    const qs = new URLSearchParams({ limit: '200' });

    if (dates) qs.set('dates', dates);

    const url =
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?${qs.toString()}`;

    const upstream = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 Corvese-Degen-Command-Center/1.7'
      }
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .json({ error: 'NFL scoreboard request failed.' });
    }

    const events = (data.events || []).map(event => {
      const c = event.competitions?.[0] || {};
      const comps = c.competitors || [];

      const home = comps.find(x => x.homeAway === 'home') || {};
      const away = comps.find(x => x.homeAway === 'away') || {};

      const st = c.status || event.status || {};
      const statusType = st.type || {};

      const team = x => ({
        id: String(x.team?.id || ''),
        name:
          x.team?.displayName ||
          x.team?.shortDisplayName ||
          x.team?.name ||
          '',
        shortName:
          x.team?.shortDisplayName ||
          x.team?.displayName ||
          '',
        abbreviation: x.team?.abbreviation || '',
        score: Number(x.score || 0)
      });

      return {
        id: String(event.id || ''),
        name: event.name || '',
        shortName: event.shortName || '',
        date: event.date || c.date || '',
        home: team(home),
        away: team(away),
        status: {
          state: statusType.state || '',
          completed: !!statusType.completed,
          detail:
            statusType.shortDetail ||
            statusType.detail ||
            st.displayClock ||
            '',
          description: statusType.description || '',
          period: Number(st.period || 0),
          clock: st.displayClock || ''
        }
      };
    });

    res.set('Cache-Control', 'no-store, max-age=0');

    return res.json({
      ok: true,
      version: 9,
      events
    });

  } catch (error) {
    console.error('NFL scoreboard request failed:', error);

    return res
      .status(502)
      .json({ error: error.message || 'NFL scoreboard request failed' });
  }
});


// -------------------------------------------------------
// FANDUEL SHARE LINK
// -------------------------------------------------------

app.get('/api/fanduel', async (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    const u = new URL(raw);

    if (
      u.protocol !== 'https:' ||
      u.hostname !== 'account.sportsbook.fanduel.com' ||
      !u.pathname.includes('/sportsbook/addToBetslip')
    ) {
      return res
        .status(400)
        .json({ error: 'Paste an official FanDuel Share My Bet link.' });
    }

    const shareCode = u.searchParams.get('shareCode');

    if (!shareCode || !/^[A-Za-z0-9_-]{4,64}$/.test(shareCode)) {
      return res
        .status(400)
        .json({ error: 'FanDuel shareCode missing or invalid.' });
    }

    const upstream = await fetch(u.toString(), {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 Corvese-Degen-Command-Center/1.7',
        Accept: 'text/html,application/xhtml+xml'
      }
    });

    const html = await upstream.text();

    const decoded = html
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&amp;/g, '&');

    const candidates = [];

    const patterns = [
      /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
      /(?:betSlip|betslip|selections|markets|shareBet)\s*[=:]\s*({[\s\S]{20,200000}?})\s*[;,<]/gi
    ];

    for (const re of patterns) {
      let m;

      while ((m = re.exec(decoded)) && candidates.length < 20) {
        candidates.push(m[1]);
      }
    }

    let payload = null;

    for (const c of candidates) {
      try {
        const j = JSON.parse(c);
        const txt = JSON.stringify(j);

        if (/selection|market|runner|odds|wager/i.test(txt)) {
          payload = j;
          break;
        }
      } catch {}
    }

    res.set('Cache-Control', 'no-store');

    return res.json({
      ok: true,
      version: 9,
      shareCode,
      url: u.toString(),
      resolved: !!payload,
      payload,
      message: payload
        ? 'FanDuel share payload found.'
        : 'FanDuel accepted the share link, but did not expose bet selections in the unauthenticated page response.'
    });

  } catch (e) {
    return res
      .status(400)
      .json({ error: e.message || 'Could not read FanDuel share link.' });
  }
});


// -------------------------------------------------------
// OPTIONAL AI BET RECOGNITION
// -------------------------------------------------------
// DCC's free browser OCR does NOT require this endpoint.

app.post('/api/bet/recognize', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        error:
          'AI recognition is not configured. Add OPENAI_API_KEY on Render.'
      });
    }

    const image = String(req.body?.image || '');

    if (!/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(image)) {
      return res
        .status(400)
        .json({ error: 'A PNG, JPEG, or WebP image is required.' });
    }

    if (image.length > 11_000_000) {
      return res
        .status(413)
        .json({ error: 'Image is too large. Use a smaller screenshot.' });
    }

    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string' },
        overallOdds: { type: 'string' },
        isFuture: { type: 'boolean' },
        startText: { type: 'string' },
        rawText: { type: 'string' },
        confidence: { type: 'number' },
        teams: {
          type: 'array',
          items: { type: 'string' }
        },
        event: {
          type: 'object',
          additionalProperties: false,
          properties: {
            away: { type: 'string' },
            home: { type: 'string' }
          },
          required: ['away', 'home']
        },
        legs: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              selection: { type: 'string' },
              market: { type: 'string' },
              line: { type: 'string' },
              odds: { type: 'string' },
              team: { type: 'string' },
              player: { type: 'string' }
            },
            required: [
              'selection',
              'market',
              'line',
              'odds',
              'team',
              'player'
            ]
          }
        }
      },
      required: [
        'type',
        'overallOdds',
        'isFuture',
        'startText',
        'rawText',
        'confidence',
        'teams',
        'event',
        'legs'
      ]
    };

    const prompt =
      `Read this FanDuel bet-share image precisely. Extract only what is visibly supported. Preserve American odds signs and decimal prop lines exactly. Type should be Straight Bet, Parlay, Same Game Parlay, or FanDuel Bet. For an event use canonical full NFL team names when clear; if no single event (such as futures), return empty away/home strings. For each leg, selection is the picked team/player/outcome, market is the wager market, line is the numeric/Over/Under line when present, odds is the leg odds when visible, team is the canonical NFL team when applicable, player is the player name when applicable. For futures set isFuture true. rawText should be a concise transcription of the useful visible bet text. confidence is 0 to 1. Never invent missing stake, payout, teams, players, lines, or odds.`;

    const upstream = await fetch(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model:
            process.env.OPENAI_VISION_MODEL ||
            'gpt-5.6-luna',
          store: false,
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: prompt
                },
                {
                  type: 'input_image',
                  image_url: image,
                  detail: 'high'
                }
              ]
            }
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'fanduel_bet',
              strict: true,
              schema
            }
          }
        })
      }
    );

    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(502).json({
        error:
          data?.error?.message ||
          `OpenAI ${upstream.status}`
      });
    }

    const outputText =
      data.output_text ||
      (data.output || [])
        .flatMap(x => x.content || [])
        .find(x => x.type === 'output_text')?.text;

    if (!outputText) {
      return res
        .status(502)
        .json({ error: 'AI returned no readable bet data.' });
    }

    const bet = JSON.parse(outputText);

    return res.json({
      ok: true,
      version: 9,
      bet
    });

  } catch (e) {
    console.error('AI bet recognition failed:', e);

    return res.status(500).json({
      error: e.message || 'AI bet recognition failed.'
    });
  }
});


// -------------------------------------------------------
// SHARED CLOUD STORAGE
// -------------------------------------------------------

function syncAuthorized(req) {
  const expected = String(process.env.DCC_SYNC_KEY || '');
  const supplied = String(req.get('x-dcc-sync-key') || '');

  return expected && supplied && expected === supplied;
}

async function redisCommand(command) {
  const url = String(
    process.env.UPSTASH_REDIS_REST_URL || ''
  ).replace(/\/$/, '');

  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      'Cloud sync storage is not configured. Add Upstash Redis REST URL and token on Render.'
    );
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });

  const j = await r.json();

  if (!r.ok || j.error) {
    throw new Error(
      j.error || `Cloud storage ${r.status}`
    );
  }

  return j.result;
}


// -------------------------------------------------------
// SHARED BETS
// -------------------------------------------------------

app.get('/api/bets', async (req, res) => {
  if (!syncAuthorized(req)) {
    return res
      .status(401)
      .json({ error: 'Invalid DCC sync key.' });
  }

  try {
    const raw = await redisCommand([
      'GET',
      'dcc:bets'
    ]);

    const draw = await redisCommand([
      'GET',
      'dcc:deleted'
    ]);

    return res.json({
      ok: true,
      version: 9,
      bets: raw ? JSON.parse(raw) : [],
      deleted: draw ? JSON.parse(draw) : {}
    });

  } catch (e) {
    return res
      .status(503)
      .json({ error: e.message });
  }
});

app.put('/api/bets', async (req, res) => {
  if (!syncAuthorized(req)) {
    return res
      .status(401)
      .json({ error: 'Invalid DCC sync key.' });
  }

  try {
    let bets =
      Array.isArray(req.body?.bets)
        ? req.body.bets
        : [];

    if (bets.length > 500) {
      return res
        .status(400)
        .json({ error: 'Too many bets.' });
    }

    const existingRaw = await redisCommand([
      'GET',
      'dcc:deleted'
    ]);

    const deleted =
      existingRaw
        ? JSON.parse(existingRaw)
        : {};

    for (const [id, ts] of Object.entries(
      req.body?.deleted || {}
    )) {
      deleted[id] = Math.max(
        Number(deleted[id] || 0),
        Number(ts || 0)
      );
    }

    bets = bets.filter(
      b =>
        !b?.id ||
        Number(deleted[b.id] || 0) <
          Number(b.updated || b.created || 0)
    );

    const raw = JSON.stringify(bets);
    const draw = JSON.stringify(deleted);

    if (raw.length > 2_000_000) {
      return res
        .status(413)
        .json({ error: 'Bet data too large.' });
    }

    await redisCommand([
      'SET',
      'dcc:deleted',
      draw
    ]);

    await redisCommand([
      'SET',
      'dcc:bets',
      raw
    ]);

    return res.json({
      ok: true,
      version: 9,
      count: bets.length
    });

  } catch (e) {
    return res
      .status(503)
      .json({ error: e.message });
  }
});


// -------------------------------------------------------
// SHARED ESPN / DASHBOARD CONFIGURATION
// -------------------------------------------------------
// Only NON-SECRET ESPN metadata is stored here.
//
// Shared:
//   league names
//   league IDs
//   team IDs
//   season
//   demo mode
//
// NOT shared:
//   ESPN_S2
//   ESPN_SWID
//   Upstash credentials
//   DCC sync key
//
// Those secrets remain server-side or local.

function sanitizeSharedConfig(input) {
  const season = Number(input?.season || 2026);

  const leagues = (
    Array.isArray(input?.leagues)
      ? input.leagues
      : []
  )
    .slice(0, 6)
    .map((l, i) => ({
      name: String(
        l?.name || `ESPN Team ${i + 1}`
      ).slice(0, 100),

      leagueId: String(
        l?.leagueId || ''
      )
        .replace(/\D/g, '')
        .slice(0, 20),

      teamId: Number(l?.teamId || 0)
    }))
    .filter(l => l.leagueId);

  return {
    version: 1,

    season:
      Number.isInteger(season) &&
      season >= 2020 &&
      season <= 2100
        ? season
        : 2026,

    leagues,

    demoMode: input?.demoMode === true,

    updatedAt: Date.now()
  };
}

app.get('/api/config', async (req, res) => {
  if (!syncAuthorized(req)) {
    return res
      .status(401)
      .json({ error: 'Invalid DCC sync key.' });
  }

  try {
    const raw = await redisCommand([
      'GET',
      'dcc:config'
    ]);

    return res.json({
      ok: true,
      version: 9,
      config: raw ? JSON.parse(raw) : null
    });

  } catch (e) {
    return res
      .status(503)
      .json({ error: e.message });
  }
});

app.put('/api/config', async (req, res) => {
  if (!syncAuthorized(req)) {
    return res
      .status(401)
      .json({ error: 'Invalid DCC sync key.' });
  }

  try {
    const config = sanitizeSharedConfig(
      req.body?.config ||
      req.body ||
      {}
    );

    await redisCommand([
      'SET',
      'dcc:config',
      JSON.stringify(config)
    ]);

    return res.json({
      ok: true,
      version: 9,
      config
    });

  } catch (e) {
    return res
      .status(503)
      .json({ error: e.message });
  }
});


// -------------------------------------------------------
// START SERVER
// -------------------------------------------------------

app.listen(
  PORT,
  '0.0.0.0',
  () =>
    console.log(
      `Corvese DCC proxy v9 listening on port ${PORT}`
    )
);
