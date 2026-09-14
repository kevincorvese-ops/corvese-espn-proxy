// Corvese Degen Command Center
// ESPN Private League Proxy — v4
//
// Adds:
// - Live fantasy scoring
// - Roster data
// - Player scoring data
// - Current matchup information
//
// Required Render environment variables:
// ESPN_S2
// ESPN_SWID
//
// Recommended:
// DASHBOARD_ORIGIN
// ALLOWED_LEAGUE_IDS

const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 10000;


// ----------------------------------------------------
// CORS
// ----------------------------------------------------

function normalizeOrigin(value) {
  return String(value || "")
    .trim()
    .replace(/\/$/, "");
}

const dashboardOrigin =
  normalizeOrigin(process.env.DASHBOARD_ORIGIN);


app.use(
  cors({
    origin(origin, callback) {

      if (
        !origin ||
        !dashboardOrigin ||
        normalizeOrigin(origin) === dashboardOrigin
      ) {
        return callback(null, true);
      }

      return callback(
        new Error("Origin not allowed")
      );
    }
  })
);


// ----------------------------------------------------
// HOME / HEALTH
// ----------------------------------------------------

app.get("/", (_req, res) => {

  res.json({
    ok: true,
    version: 4,
    service:
      "Corvese Degen Command Center ESPN Proxy",
    endpoint: "/api/espn"
  });

});


app.get("/health", (_req, res) => {

  res.json({
    ok: true,
    version: 4
  });

});


// ----------------------------------------------------
// LEAGUE SECURITY
// ----------------------------------------------------

function allowedLeague(leagueId) {

  const allowed =
    (process.env.ALLOWED_LEAGUE_IDS || "")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);

  return (
    !allowed.length ||
    allowed.includes(String(leagueId))
  );
}


// ----------------------------------------------------
// ESPN REQUEST
// ----------------------------------------------------

async function espnGet(baseUrl, params = {}) {

  const qs = new URLSearchParams();

  for (
    const [key, value]
    of Object.entries(params)
  ) {

    if (Array.isArray(value)) {

      value.forEach(v =>
        qs.append(key, String(v))
      );

    } else if (
      value !== undefined &&
      value !== null
    ) {

      qs.append(key, String(value));

    }
  }


  const url =
    `${baseUrl}?${qs.toString()}`;


  const response = await fetch(
    url,
    {
      headers: {

        Cookie:
          `espn_s2=${process.env.ESPN_S2}; ` +
          `SWID=${process.env.ESPN_SWID}`,

        Accept:
          "application/json, text/plain, */*",

        "User-Agent":
          "Mozilla/5.0 " +
          "Corvese-Degen-Command-Center/1.4"

      }
    }
  );


  const text =
    await response.text();


  if (!response.ok) {

    const error =
      new Error(
        `ESPN upstream ${response.status}`
      );

    error.status =
      response.status;

    error.body =
      text.slice(0, 500);

    throw error;
  }


  try {

    return JSON.parse(text);

  } catch {

    throw new Error(
      "ESPN returned non-JSON data"
    );

  }
}


// ----------------------------------------------------
// ESPN API
// ----------------------------------------------------

app.get(
  "/api/espn",
  async (req, res) => {

    const leagueId =
      req.query.leagueId;

    const season =
      req.query.season || "2026";


    // ----------------------------------------------
    // Validate league
    // ----------------------------------------------

    if (
      !leagueId ||
      !/^\d+$/.test(
        String(leagueId)
      )
    ) {

      return res
        .status(400)
        .json({
          error:
            "Valid numeric leagueId required"
        });

    }


    // ----------------------------------------------
    // Validate season
    // ----------------------------------------------

    if (
      !/^\d{4}$/.test(
        String(season)
      )
    ) {

      return res
        .status(400)
        .json({
          error:
            "Valid four-digit season required"
        });

    }


    // ----------------------------------------------
    // Check league allow list
    // ----------------------------------------------

    if (
      !allowedLeague(leagueId)
    ) {

      return res
        .status(403)
        .json({
          error:
            "League not allowed by proxy configuration"
        });

    }


    // ----------------------------------------------
    // Make sure credentials exist
    // ----------------------------------------------

    if (
      !process.env.ESPN_S2 ||
      !process.env.ESPN_SWID
    ) {

      return res
        .status(500)
        .json({
          error:
            "ESPN credentials not configured on server"
        });

    }


    const base =
      "https://lm-api-reads.fantasy.espn.com" +
      "/apis/v3/games/ffl" +
      `/seasons/${season}` +
      "/segments/0" +
      `/leagues/${leagueId}`;


    try {

      // --------------------------------------------
      // REQUEST #1
      //
      // Determine ESPN's current scoring period
      // and matchup period.
      // --------------------------------------------

      const league =
        await espnGet(
          base,
          {
            view: [
              "mTeam",
              "mStatus",
              "mScoreboard"
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

        ) || 1;


      const matchupPeriodId =
        Number(

          league.status
            ?.currentMatchupPeriod ??

          league.status
            ?.currentMatchupPeriodId ??

          scoringPeriodId

        ) || scoringPeriodId;


      // --------------------------------------------
      // REQUEST #2
      //
      // Get the actual live matchup information.
      //
      // mLiveScoring is particularly important here.
      // --------------------------------------------

      const live =
        await espnGet(
          base,
          {

            view: [

              "mTeam",

              "mRoster",

              "mMatchup",

              "mMatchupScore",

              "mScoreboard",

              "mLiveScoring",

              "mStatus"

            ],

            scoringPeriodId:
              scoringPeriodId,

            matchupPeriodId:
              matchupPeriodId

          }
        );


      // --------------------------------------------
      // MERGE RESPONSES
      // --------------------------------------------

      const merged = {

        ...league,

        ...live,


        teams:

          Array.isArray(live.teams) &&
          live.teams.length

            ? live.teams

            : league.teams,


        schedule:

          Array.isArray(live.schedule) &&
          live.schedule.length

            ? live.schedule

            : league.schedule,


        scoringPeriodId:

          live.scoringPeriodId ??

          league.scoringPeriodId ??

          scoringPeriodId,


        status: {

          ...(league.status || {}),

          ...(live.status || {})

        },


        // ------------------------------------------
        // Debug information.
        //
        // Safe to expose:
        // Contains no ESPN cookies.
        // ------------------------------------------

        _dcc: {

          version: 4,

          scoringPeriodId:
            scoringPeriodId,

          matchupPeriodId:
            matchupPeriodId,

          liveScoringRequested:
            true,

          rosterRequested:
            true,

          matchupScoreRequested:
            true,

          scheduleRows:
            Array.isArray(live.schedule)
              ? live.schedule.length
              : 0,

          teamRows:
            Array.isArray(live.teams)
              ? live.teams.length
              : 0

        }

      };


      // Never cache live fantasy data.

      res.set(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
      );

      res.set(
        "Pragma",
        "no-cache"
      );

      res.set(
        "Expires",
        "0"
      );


      return res.json(merged);

    } catch (error) {

      console.error(
        "ESPN upstream request failed:",
        error
      );


      return res
        .status(
          error.status || 502
        )
        .json({

          error:
            error.message ||
            "ESPN upstream request failed",

          version: 4

        });

    }

  }
);


// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Corvese ESPN Proxy v4 ` +
      `listening on port ${PORT}`
    );

  }
);
