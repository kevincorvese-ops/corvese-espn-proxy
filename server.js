// Corvese Degen Command Center — secure ESPN/FanDuel helper proxy
// Server version 8
//
// Required for private ESPN fantasy:
//   ESPN_S2
//   ESPN_SWID
//
// Cloud sync:
//   DCC_SYNC_KEY
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//
// Optional:
//   DASHBOARD_ORIGIN
//   ALLOWED_LEAGUE_IDS

const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '12mb' }));

const PORT = process.env.PORT || 10000;

const normalizeOrigin = value =>
  String(value || '').trim().replace(/\/$/, '');

const dashboardOrigin =
  normalizeOrigin(process.env.DASHBOARD_ORIGIN);

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


// ============================================================
// HEALTH / VERSION
// ============================================================

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    version: 8,
    service: 'Corvese Degen Command Center Proxy',
    endpoints: [
      '/api/espn',
      '/api/nfl/scoreboard',
      '/api/fanduel',
      '/api/bet/recognize',
      '/api/bets'
    ]
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    version: 8
  });
});


// ============================================================
// ESPN FANTASY
// ============================================================

function allowedLeague(leagueId) {
  const allowed = (process.env.ALLOWED_LEAGUE_IDS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  return !allowed.length || allowed.includes(String(leagueId));
}

async function espnGet(baseUrl, params) {
  const qs = new URLSearchParams();

  for (const [key, value] of Object.entries(params || {})) {
    if (Array.isArray(value)) {
      value.forEach(v => qs.append(key, String(v)));
    } else if (value !== undefined && value !== null) {
      qs.append(key, String(value));
    }
  }

  const upstream = await fetch(`${baseUrl}?${qs.toString()}`, {
    headers: {
      Cookie:
        `espn_s2=${process.env.ESPN_S2}; ` +
        `SWID=${process.env.ESPN_SWID}`,
      Accept: 'application/json, text/plain, */*',
      'User-Agent':
        'Mozilla/5.0 Corvese-Degen-Command-Center/1.7'
    }
  });

  const text = await upstream.text();

  if (!upstream.ok) {
    const error =
      new Error(`ESPN upstream ${upstream.status}`);

    error.status = upstream.status;
    throw error;
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

  if (!leagueId || !/^\d+$/.test(String(leagueId))) {
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
    `https://lm-api-reads.fantasy.espn.com/apis/v3/` +
    `games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;

  try {
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
        version: 8,
        scoringPeriodId,
        matchupPeriodId
      }
    };

    res.set('Cache-Control', 'no-store');

    return res.json(merged);

  } catch (error) {
    console.error(
      'ESPN fantasy upstream request failed:',
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


// ============================================================
// NFL SCOREBOARD
// ============================================================

app.get('/api/nfl/scoreboard', async (req, res) => {
  try {
    const from =
      String(req.query.from || '').trim();

    const to =
      String(req.query.to || '').trim();

    const valid = value =>
      /^\d{8}$/.test(value);

    if (
      (from && !valid(from)) ||
      (to && !valid(to))
    ) {
      return res.status(400).json({
        error: 'Dates must be YYYYMMDD.'
      });
    }

    const dates =
      from && to
        ? `${from}-${to}`
        : (from || to || '');

    const qs =
      new URLSearchParams({
        limit: '200'
      });

    if (dates) {
      qs.set('dates', dates);
    }

    const url =
      'https://site.api.espn.com/apis/site/v2/' +
      `sports/football/nfl/scoreboard?${qs.toString()}`;

    const upstream = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 Corvese-Degen-Command-Center/1.7'
      }
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .json({
          error: 'NFL scoreboard request failed.'
        });
    }

    const events =
      (data.events || []).map(event => {
        const competition =
          event.competitions?.[0] || {};

        const competitors =
          competition.competitors || [];

        const home =
          competitors.find(
            x => x.homeAway === 'home'
          ) || {};

        const away =
          competitors.find(
            x => x.homeAway === 'away'
          ) || {};

        const status =
          competition.status ||
          event.status ||
          {};

        const statusType =
          status.type || {};

        const team = competitor => ({
          id:
            String(
              competitor.team?.id || ''
            ),

          name:
            competitor.team?.displayName ||
            competitor.team?.shortDisplayName ||
            competitor.team?.name ||
            '',

          shortName:
            competitor.team?.shortDisplayName ||
            competitor.team?.displayName ||
            '',

          abbreviation:
            competitor.team?.abbreviation ||
            '',

          score:
            Number(
              competitor.score || 0
            )
        });

        return {
          id:
            String(event.id || ''),

          name:
            event.name || '',

          shortName:
            event.shortName || '',

          date:
            event.date ||
            competition.date ||
            '',

          home:
            team(home),

          away:
            team(away),

          status: {
            state:
              statusType.state || '',

            completed:
              !!statusType.completed,

            detail:
              statusType.shortDetail ||
              statusType.detail ||
              status.displayClock ||
              '',

            description:
              statusType.description || '',

            period:
              Number(status.period || 0),

            clock:
              status.displayClock || ''
          }
        };
      });

    res.set(
      'Cache-Control',
      'no-store, max-age=0'
    );

    return res.json({
      ok: true,
      version: 8,
      events
    });

  } catch (error) {
    console.error(
      'NFL scoreboard request failed:',
      error
    );

    return res.status(502).json({
      error:
        error.message ||
        'NFL scoreboard request failed'
    });
  }
});


// ============================================================
// FANDUEL SHARE LINK
// ============================================================

app.get('/api/fanduel', async (req, res) => {
  try {
    const raw =
      String(req.query.url || '').trim();

    const url =
      new URL(raw);

    if (
      url.protocol !== 'https:' ||
      url.hostname !==
        'account.sportsbook.fanduel.com' ||
      !url.pathname.includes(
        '/sportsbook/addToBetslip'
      )
    ) {
      return res.status(400).json({
        error:
          'Paste an official FanDuel Share My Bet link.'
      });
    }

    const shareCode =
      url.searchParams.get('shareCode');

    if (
      !shareCode ||
      !/^[A-Za-z0-9_-]{4,64}$/.test(
        shareCode
      )
    ) {
      return res.status(400).json({
        error:
          'FanDuel shareCode missing or invalid.'
      });
    }

    const upstream =
      await fetch(url.toString(), {
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 Corvese-Degen-Command-Center/1.7',
          Accept:
            'text/html,application/xhtml+xml'
        }
      });

    const html =
      await upstream.text();

    const decoded =
      html
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, '&');

    const candidates = [];

    const patterns = [
      /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
      /(?:betSlip|betslip|selections|markets|shareBet)\s*[=:]\s*({[\s\S]{20,200000}?})\s*[;,<]/gi
    ];

    for (const regex of patterns) {
      let match;

      while (
        (match = regex.exec(decoded)) &&
        candidates.length < 20
      ) {
        candidates.push(match[1]);
      }
    }

    let payload = null;

    for (const candidate of candidates) {
      try {
        const json =
          JSON.parse(candidate);

        const text =
          JSON.stringify(json);

        if (
          /selection|market|runner|odds|wager/i.test(
            text
          )
        ) {
          payload = json;
          break;
        }
      } catch {
        // Ignore invalid candidate JSON.
      }
    }

    res.set(
      'Cache-Control',
      'no-store'
    );

    return res.json({
      ok: true,
      version: 8,
      shareCode,
      url: url.toString(),
      resolved: !!payload,
      payload,

      message:
        payload
          ? 'FanDuel share payload found.'
          : 'FanDuel accepted the share link, but did not expose bet selections in the unauthenticated page response.'
    });

  } catch (error) {
    return res.status(400).json({
      error:
        error.message ||
        'Could not read FanDuel share link.'
    });
  }
});


// ============================================================
// OPTIONAL AI RECOGNITION
// ============================================================
// DCC v7.3 uses the free browser OCR path by default.
// This endpoint remains available only if an OpenAI key is
// configured in the future.

app.post('/api/bet/recognize', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        error:
          'AI recognition is not configured.'
      });
    }

    const image =
      String(req.body?.image || '');

    if (
      !/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(
        image
      )
    ) {
      return res.status(400).json({
        error:
          'A PNG, JPEG, or WebP image is required.'
      });
    }

    if (image.length > 11_000_000) {
      return res.status(413).json({
        error:
          'Image is too large.'
      });
    }

    return res.status(503).json({
      error:
        'DCC is currently configured to use free local OCR.'
    });

  } catch (error) {
    return res.status(500).json({
      error:
        error.message ||
        'Recognition failed.'
    });
  }
});


// ============================================================
// CROSS-DEVICE BET SYNC
// ============================================================

function syncAuthorized(req) {
  const expected =
    String(
      process.env.DCC_SYNC_KEY || ''
    );

  const supplied =
    String(
      req.get('x-dcc-sync-key') || ''
    );

  return (
    expected &&
    supplied &&
    expected === supplied
  );
}


async function redisCommand(command) {
  const url =
    String(
      process.env.UPSTASH_REDIS_REST_URL ||
      ''
    ).replace(/\/$/, '');

  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      'Cloud sync storage is not configured.'
    );
  }

  const response =
    await fetch(url, {
      method: 'POST',

      headers: {
        Authorization:
          `Bearer ${token}`,

        'Content-Type':
          'application/json'
      },

      body:
        JSON.stringify(command)
    });

  const json =
    await response.json();

  if (
    !response.ok ||
    json.error
  ) {
    throw new Error(
      json.error ||
      `Cloud storage ${response.status}`
    );
  }

  return json.result;
}


// ------------------------------------------------------------
// GET BETS
// ------------------------------------------------------------

app.get('/api/bets', async (req, res) => {
  if (!syncAuthorized(req)) {
    return res.status(401).json({
      error:
        'Invalid DCC sync key.'
    });
  }

  try {
    const raw =
      await redisCommand([
        'GET',
        'dcc:bets'
      ]);

    const deletedRaw =
      await redisCommand([
        'GET',
        'dcc:deleted'
      ]);

    return res.json({
      ok: true,
      version: 8,

      bets:
        raw
          ? JSON.parse(raw)
          : [],

      deleted:
        deletedRaw
          ? JSON.parse(deletedRaw)
          : {}
    });

  } catch (error) {
    return res.status(503).json({
      error: error.message
    });
  }
});


// ------------------------------------------------------------
// SAVE / DELETE / CLEAR BETS
// ------------------------------------------------------------

app.put('/api/bets', async (req, res) => {
  if (!syncAuthorized(req)) {
    return res.status(401).json({
      error:
        'Invalid DCC sync key.'
    });
  }

  try {
    let bets =
      Array.isArray(req.body?.bets)
        ? req.body.bets
        : [];

    if (bets.length > 500) {
      return res.status(400).json({
        error:
          'Too many bets.'
      });
    }

    const existingDeletedRaw =
      await redisCommand([
        'GET',
        'dcc:deleted'
      ]);

    const deleted =
      existingDeletedRaw
        ? JSON.parse(
            existingDeletedRaw
          )
        : {};

    const incomingDeleted =
      req.body?.deleted || {};

    for (
      const [id, timestamp]
      of Object.entries(
        incomingDeleted
      )
    ) {
      deleted[id] =
        Math.max(
          Number(
            deleted[id] || 0
          ),

          Number(
            timestamp || 0
          )
        );
    }

    // Tombstones prevent a bet deleted on one device from
    // being restored by an older copy on another device.
    bets =
      bets.filter(bet => {
        if (!bet?.id) {
          return true;
        }

        const deletionTime =
          Number(
            deleted[bet.id] || 0
          );

        const updateTime =
          Number(
            bet.updated ||
            bet.created ||
            0
          );

        return (
          deletionTime <
          updateTime
        );
      });

    const raw =
      JSON.stringify(bets);

    const deletedJSON =
      JSON.stringify(deleted);

    if (raw.length > 2_000_000) {
      return res.status(413).json({
        error:
          'Bet data too large.'
      });
    }

    await redisCommand([
      'SET',
      'dcc:deleted',
      deletedJSON
    ]);

    await redisCommand([
      'SET',
      'dcc:bets',
      raw
    ]);

    return res.json({
      ok: true,
      version: 8,
      count: bets.length
    });

  } catch (error) {
    return res.status(503).json({
      error: error.message
    });
  }
});


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `Corvese DCC proxy v8 listening on port ${PORT}`
    );
  }
);
