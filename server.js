// Corvese Degen Command Center — secure ESPN/FanDuel helper proxy v6.
// Required env vars for private ESPN fantasy leagues: ESPN_S2, ESPN_SWID
// Optional env vars: DASHBOARD_ORIGIN, ALLOWED_LEAGUE_IDS

const express = require('express');
const cors = require('cors');

const app = express();
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


// --------------------------------------------------
// STATUS
// --------------------------------------------------

app.get('/', (_req, res) => res.json({
  ok: true,
  version: 6,
  service: 'Corvese Degen Command Center Proxy',
  endpoints: [
    '/api/espn',
    '/api/nfl/scoreboard',
    '/api/fanduel'
  ]
}));

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    version: 6
  })
);


// --------------------------------------------------
// ESPN FANTASY
// --------------------------------------------------

function allowedLeague(leagueId) {
  const allowed =
    (process.env.ALLOWED_LEAGUE_IDS || '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);

  return (
    !allowed.length ||
    allowed.includes(String(leagueId))
  );
}

async function espnGet(baseUrl, params) {
  const qs = new URLSearchParams();

  for (
    const [k, value]
    of Object.entries(params || {})
  ) {
    if (Array.isArray(value)) {
      value.forEach(v =>
        qs.append(k, String(v))
      );
    } else if (
      value !== undefined &&
      value !== null
    ) {
      qs.append(k, String(value));
    }
  }

  const upstream = await fetch(
    `${baseUrl}?${qs.toString()}`,
    {
      headers: {
        Cookie:
          `espn_s2=${process.env.ESPN_S2}; ` +
          `SWID=${process.env.ESPN_SWID}`,

        Accept:
          'application/json, text/plain, */*',

        'User-Agent':
          'Mozilla/5.0 Corvese-Degen-Command-Center/1.6'
      }
    }
  );

  const text = await upstream.text();

  if (!upstream.ok) {
    const err =
      new Error(
        `ESPN upstream ${upstream.status}`
      );

    err.status = upstream.status;
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      'ESPN returned non-JSON data'
    );
  }
}

app.get(
  '/api/espn',
  async (req, res) => {

    const {
      leagueId,
      season = '2026'
    } = req.query;

    if (
      !leagueId ||
      !/^\d+$/.test(String(leagueId))
    ) {
      return res
        .status(400)
        .json({
          error:
            'Valid numeric leagueId required'
        });
    }

    if (
      !/^\d{4}$/.test(String(season))
    ) {
      return res
        .status(400)
        .json({
          error:
            'Valid four-digit season required'
        });
    }

    if (!allowedLeague(leagueId)) {
      return res
        .status(403)
        .json({
          error:
            'League not allowed by proxy configuration'
        });
    }

    if (
      !process.env.ESPN_S2 ||
      !process.env.ESPN_SWID
    ) {
      return res
        .status(500)
        .json({
          error:
            'ESPN credentials not configured on server'
        });
    }

    const base =
      `https://lm-api-reads.fantasy.espn.com` +
      `/apis/v3/games/ffl` +
      `/seasons/${season}` +
      `/segments/0/leagues/${leagueId}`;

    try {

      const league =
        await espnGet(
          base,
          {
            view: [
              'mTeam',
              'mStatus',
              'mScoreboard'
            ]
          }
        );

      const scoringPeriodId =
        Number(
          league.scoringPeriodId ??
          league.status
            ?.currentScoringPeriod ??
          league.status
            ?.currentScoringPeriodId ??
          league.status
            ?.latestScoringPeriod
        ) || undefined;

      const matchupPeriodId =
        Number(
          league.status
            ?.currentMatchupPeriod ??
          league.status
            ?.currentMatchupPeriodId ??
          scoringPeriodId
        ) || undefined;

      const matchup =
        await espnGet(
          base,
          {
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
          }
        );

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
          version: 6,
          scoringPeriodId,
          matchupPeriodId
        }
      };

      res.set(
        'Cache-Control',
        'no-store'
      );

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
  }
);


// --------------------------------------------------
// NFL LIVE SCOREBOARD
//
// Used to connect imported FanDuel bets to
// live NFL games.
// --------------------------------------------------

app.get(
  '/api/nfl/scoreboard',
  async (req, res) => {

    try {

      const from =
        String(
          req.query.from || ''
        ).trim();

      const to =
        String(
          req.query.to || ''
        ).trim();

      const valid =
        value =>
          /^\d{8}$/.test(value);

      if (
        (from && !valid(from)) ||
        (to && !valid(to))
      ) {
        return res
          .status(400)
          .json({
            error:
              'Dates must be YYYYMMDD.'
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
        qs.set(
          'dates',
          dates
        );
      }

      const url =
        `https://site.api.espn.com` +
        `/apis/site/v2/sports/football/nfl/scoreboard` +
        `?${qs.toString()}`;

      const upstream =
        await fetch(
          url,
          {
            headers: {
              Accept:
                'application/json',

              'User-Agent':
                'Mozilla/5.0 Corvese-Degen-Command-Center/1.6'
            }
          }
        );

      const data =
        await upstream.json();

      if (!upstream.ok) {
        return res
          .status(upstream.status)
          .json({
            error:
              'NFL scoreboard request failed.'
          });
      }

      const events =
        (data.events || [])
          .map(event => {

            const competition =
              event.competitions?.[0] || {};

            const competitors =
              competition.competitors || [];

            const home =
              competitors.find(
                x =>
                  x.homeAway === 'home'
              ) || {};

            const away =
              competitors.find(
                x =>
                  x.homeAway === 'away'
              ) || {};

            const status =
              competition.status ||
              event.status ||
              {};

            const statusType =
              status.type || {};

            const team =
              competitor => ({
                id:
                  String(
                    competitor.team?.id ||
                    ''
                  ),

                name:
                  competitor.team
                    ?.displayName ||
                  competitor.team
                    ?.shortDisplayName ||
                  competitor.team
                    ?.name ||
                  '',

                shortName:
                  competitor.team
                    ?.shortDisplayName ||
                  competitor.team
                    ?.displayName ||
                  '',

                abbreviation:
                  competitor.team
                    ?.abbreviation ||
                  '',

                score:
                  Number(
                    competitor.score || 0
                  )
              });

            return {
              id:
                String(
                  event.id || ''
                ),

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
                  statusType.state ||
                  '',

                completed:
                  !!statusType.completed,

                detail:
                  statusType.shortDetail ||
                  statusType.detail ||
                  status.displayClock ||
                  '',

                description:
                  statusType.description ||
                  '',

                period:
                  Number(
                    status.period || 0
                  ),

                clock:
                  status.displayClock ||
                  ''
              }
            };
          });

      res.set(
        'Cache-Control',
        'no-store, max-age=0'
      );

      return res.json({
        ok: true,
        version: 6,
        events
      });

    } catch (error) {

      console.error(
        'NFL scoreboard request failed:',
        error
      );

      return res
        .status(502)
        .json({
          error:
            error.message ||
            'NFL scoreboard request failed'
        });
    }
  }
);


// --------------------------------------------------
// FANDUEL SHARE LINK
//
// Does NOT log into your FanDuel account.
// This only attempts to resolve information FanDuel
// exposes publicly through a Share My Bet URL.
// --------------------------------------------------

app.get(
  '/api/fanduel',
  async (req, res) => {

    try {

      const raw =
        String(
          req.query.url || ''
        ).trim();

      const u =
        new URL(raw);

      if (
        u.protocol !== 'https:' ||
        u.hostname !==
          'account.sportsbook.fanduel.com' ||
        !u.pathname.includes(
          '/sportsbook/addToBetslip'
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'Paste an official FanDuel Share My Bet link.'
          });
      }

      const shareCode =
        u.searchParams.get(
          'shareCode'
        );

      if (
        !shareCode ||
        !/^[A-Za-z0-9_-]{4,64}$/
          .test(shareCode)
      ) {
        return res
          .status(400)
          .json({
            error:
              'FanDuel shareCode missing or invalid.'
          });
      }

      const upstream =
        await fetch(
          u.toString(),
          {
            redirect: 'follow',

            headers: {
              'User-Agent':
                'Mozilla/5.0 Corvese-Degen-Command-Center/1.6',

              Accept:
                'text/html,application/xhtml+xml'
            }
          }
        );

      const html =
        await upstream.text();

      const decoded =
        html
          .replace(
            /&quot;/g,
            '"'
          )
          .replace(
            /&#34;/g,
            '"'
          )
          .replace(
            /&amp;/g,
            '&'
          );

      const candidates = [];

      const patterns = [

        /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,

        /(?:betSlip|betslip|selections|markets|shareBet)\s*[=:]\s*({[\s\S]{20,200000}?})\s*[;,<]/gi

      ];

      for (const re of patterns) {

        let match;

        while (
          (
            match =
              re.exec(decoded)
          ) &&
          candidates.length < 20
        ) {
          candidates.push(
            match[1]
          );
        }
      }

      let payload = null;

      for (
        const candidate
        of candidates
      ) {

        try {

          const json =
            JSON.parse(candidate);

          const text =
            JSON.stringify(json);

          if (
            /selection|market|runner|odds|wager/i
              .test(text)
          ) {
            payload = json;
            break;
          }

        } catch {
          // Ignore non-JSON candidates.
        }
      }

      res.set(
        'Cache-Control',
        'no-store'
      );

      return res.json({

        ok: true,
        version: 6,

        shareCode,

        url:
          u.toString(),

        resolved:
          !!payload,

        payload,

        message:
          payload
            ? 'FanDuel share payload found.'
            : 'FanDuel accepted the share link, but did not expose bet selections in the unauthenticated page response.'
      });

    } catch (error) {

      return res
        .status(400)
        .json({
          error:
            error.message ||
            'Could not read FanDuel share link.'
        });
    }
  }
);


// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `Corvese DCC proxy v6 listening on port ${PORT}`
    );
  }
);
