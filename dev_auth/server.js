const express = require("express");
const { rateLimit } = require("express-rate-limit");
const path = require("node:path");


if (process.env.NODE_ENV !== "production") {
  require("dotenv").config({ path: path.join(__dirname, "secrets", ".env") });
}

const app = express();

app.get("/ads.txt", (req, res) => {
  res.type("text/plain");
  res.sendFile(path.join(__dirname, "ads.txt"));
});


app.set('trust proxy', 1);

app.use(express.json({ limit: "20kb" }));

// Bloquer l'accès public aux données et fichiers internes.
app.use((req, res, next) => {
  const path = req.path;
  if (
    /^\/(data|secrets|node_modules|\.git)(\/|$)/i.test(path) ||
    /^\/(server\.js|auth\.js|package\.json|package-lock\.json|install_login\.py)$/i.test(path) ||
    /\.before-[^/]+$/i.test(path) ||
    /\.sqlite(?:-wal|-shm)?$/i.test(path)
  ) {
    return res.sendStatus(404);
  }
  next();
});
const { attachAuth, consumeAnalysisQuota, recordAnalysisStart, finishAnalysisEvent, finishAnalysisEventForUser } = require("./auth");
const { transaction } = require("./db/postgres");
const requireAuth = attachAuth(app);

// Le panel est servi uniquement après vérification de la session et du rôle.
app.get("/admin.html", requireAuth, (req, res) => {
  res.set("Cache-Control", "no-store");
  if (req.user?.role !== "admin") {
    return res.status(403).send(
      "<!doctype html><html lang=\"fr\"><meta charset=\"utf-8\"><title>Accès refusé</title>" +
      "<body style=\"font:16px system-ui;padding:2rem;background:#0b1120;color:#eee\">" +
      "<h1>Accès refusé</h1><p>Cette page est réservée aux administrateurs.</p>" +
      "<a style=\"color:#10b981\" href=\"/\">Retour au site</a></body></html>"
    );
  }
  return res.sendFile("admin.html", { root: __dirname });
});

// Ne servir que les fichiers publics explicitement autorisés.
app.get("/googlefdce16d1dafef101.html", (req, res) => {
  res.type("text/plain");
  res.sendFile(path.join(__dirname, "googlefdce16d1dafef101.html"));
});

app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/app.stable.js", (req, res) => {
  res.sendFile(path.join(__dirname, "app.stable.js"));
});

app.get("/manifest.json", (req, res) => {
  res.type("application/manifest+json");
  res.sendFile(path.join(__dirname, "manifest.json"));
});

app.get("/admin.js", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "admin.js"));
});

app.get("/icon.svg", (req, res) => {
  res.sendFile(path.join(__dirname, "icon.svg"));
});

const PUBLIC_ICONS = new Set([
  "apple-touch-icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "maskable-512.png"
]);

app.get("/icons/:filename", (req, res) => {
  if (!PUBLIC_ICONS.has(req.params.filename)) {
    return res.sendStatus(404);
  }
  return res.sendFile(path.join(__dirname, "icons", req.params.filename));
});


const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODEL = "openai/gpt-oss-20b";
const keyManager = require("./key-manager");
const { query: analysisQuery } = require("./db/postgres");

async function ensureMatchAnalysesTable() {
  await analysisQuery(`
    CREATE TABLE IF NOT EXISTS match_analyses (
      event_id TEXT PRIMARY KEY,
      match_text TEXT NOT NULL DEFAULT '',
      competition TEXT NOT NULL DEFAULT '',
      match_date TEXT NOT NULL DEFAULT '',
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'ready', 'error')),
      generated_at TIMESTAMPTZ,
      claim_token TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Migration sans suppression des analyses existantes.
  await analysisQuery(`
    ALTER TABLE match_analyses
    ADD COLUMN IF NOT EXISTS claim_token TEXT
  `);

  console.log("Stockage des analyses de matchs prêt.");
}

async function generateFootballAnalysis(context) {
  const response = await fetch(NVIDIA_BASE_URL + "/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + keyManager.getNextKey(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: [
        {
          role: "system",
          content: `Tu es un analyste football professionnel spécialisé dans les pronostics sportifs.
Analyse uniquement les données fournies. Ne jamais inventer de statistiques absentes.
Choisis les marchés les plus pertinents selon les informations disponibles.
Réponds uniquement avec un JSON valide, sans markdown, au format :
{
  "resume":"Résumé professionnel du rapport de force entre les équipes.",
  "pronostics":[
    {
      "marche":"Nom du marché",
      "choix":"Pronostic sélectionné",
      "probabilite":"Pourcentage estimé",
      "confiance":"Faible|Moyenne|Élevée",
      "explication":"Explication fondée uniquement sur les données disponibles."
    }
  ],
  "bilan_final":"Synthèse des opportunités et des risques. Aucun pronostic n'est garanti."
}
Règles : exactement 3 pronostics, classés du plus intéressant au moins intéressant. Ne jamais inventer de données ni garantir un résultat.`
        },
        { role: "user", content: JSON.stringify(context) }
      ],
      temperature: 0.6,
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    throw new Error("NVIDIA HTTP " + response.status);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");

  if (first < 0 || last <= first) {
    throw new Error("Réponse IA non exploitable.");
  }

  const result = JSON.parse(content.slice(first, last + 1));

  if (!Array.isArray(result.pronostics) || result.pronostics.length !== 3) {
    throw new Error("L'IA n'a pas renvoyé exactement trois pronostics.");
  }

  return result;
}

function espnEventContext(event, summary = {}) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find(t => t.homeAway === "home") || competitors[0];
  const away = competitors.find(t => t.homeAway === "away") || competitors[1];
  const homeName = home?.team?.displayName || "Équipe domicile";
  const awayName = away?.team?.displayName || "Équipe extérieure";

  return {
    match: `${homeName} (domicile) vs ${awayName} (extérieur)`,
    championnat: competition.league?.name || competition.name ||
      event.season?.slug || "Football",
    date: event.date || "",
    stade: competition.venue?.fullName || "Non communiqué",
    domicile: {
      nom: homeName,
      forme: home?.form || "",
      bilan: home?.records?.[0]?.summary || "",
      score: home?.score || null
    },
    exterieur: {
      nom: awayName,
      forme: away?.form || "",
      bilan: away?.records?.[0]?.summary || "",
      score: away?.score || null
    },
    statistiques_et_donnees_avant_match: {
      boxscore: summary.boxscore || null,
      derniers_matchs: summary.lastFiveGames || [],
      confrontations_directes: summary.headToHeadGames || [],
      classement: summary.standings || [],
      joueurs_cles: summary.leaders || [],
      absences: summary.injuries || [],
      cotes: summary.odds || summary.pickcenter || []
    }
  };
}

let precomputeRunning = false;

async function precomputeUpcomingMatches() {
  // Empêche tout chevauchement si une génération dépasse une minute.
  if (precomputeRunning) {
    console.log("Pré-calcul déjà en cours : passage ignoré.");
    return;
  }

  precomputeRunning = true;

  try {
    await ensureMatchAnalysesTable();

    const now = new Date();
    const dates = [-1, 0, 1].map(offset => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + offset);
      return [
        d.getUTCFullYear(),
        String(d.getUTCMonth() + 1).padStart(2, "0"),
        String(d.getUTCDate()).padStart(2, "0")
      ].join("");
    });

    const boards = await Promise.all(
      dates.map(date =>
        fetchESPN(`${ESPN_SOCCER_API}/scoreboard?dates=${date}`)
      )
    );

    const unique = new Map();
    for (const board of boards) {
      for (const event of board.events || []) {
        if (event?.id) unique.set(String(event.id), event);
      }
    }

    const upcoming = [...unique.values()]
      .filter(event => {
        const date = new Date(event.date).getTime();
        const state = event.competitions?.[0]?.status?.type?.state;
        return state === "pre" &&
          date > Date.now() &&
          date <= Date.now() + 24 * 60 * 60 * 1000;
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    console.log(`Pré-calcul : ${upcoming.length} matchs à vérifier.`);

    // Cherche le prochain match non encore analysé.
    // Un résultat "ready" est conservé définitivement et jamais régénéré.
    for (const event of upcoming) {
      const id = String(event.id);
      const competition = event.competitions?.[0] || {};
      const competitors = competition.competitors || [];
      const home = competitors.find(t => t.homeAway === "home") || competitors[0];
      const away = competitors.find(t => t.homeAway === "away") || competitors[1];
      const matchText =
        `${home?.team?.displayName || "Domicile"} vs ${away?.team?.displayName || "Extérieur"}`;
      const claimToken = require("crypto").randomUUID();

      const claim = await analysisQuery(`
        INSERT INTO match_analyses
          (event_id, match_text, competition, match_date, status,
           claim_token, updated_at)
        VALUES ($1, $2, $3, $4, 'processing', $5, NOW())
        ON CONFLICT (event_id) DO UPDATE SET
          match_text = EXCLUDED.match_text,
          competition = EXCLUDED.competition,
          match_date = EXCLUDED.match_date,
          status = 'processing',
          claim_token = EXCLUDED.claim_token,
          updated_at = NOW()
        WHERE match_analyses.status <> 'ready'
          AND (
            match_analyses.status = 'pending'
            OR (
              match_analyses.status = 'error'
              AND match_analyses.updated_at < NOW() - INTERVAL '15 minutes'
            )
            OR (
              match_analyses.status = 'processing'
              AND match_analyses.updated_at < NOW() - INTERVAL '20 minutes'
            )
          )
        RETURNING event_id
      `, [
        id,
        matchText,
        competition.name || competition.league?.name || "Football",
        event.date || "",
        claimToken
      ]);

      // Déjà prêt, en cours, ou en attente du délai de nouvelle tentative :
      // passe au match suivant sans bloquer la file.
      if (!claim.rowCount) continue;

      console.log("Début analyse pré-calculée :", id, matchText);

      try {
        const summary = await fetchESPN(
          `${ESPN_SOCCER_API}/summary?event=${encodeURIComponent(id)}`
        );
        const context = espnEventContext(event, summary);
        const result = await generateFootballAnalysis(context);

        const saved = await analysisQuery(`
          UPDATE match_analyses
          SET context = $2::jsonb,
              result = $3::jsonb,
              status = 'ready',
              generated_at = NOW(),
              updated_at = NOW()
          WHERE event_id = $1
            AND status = 'processing'
            AND claim_token = $4
        `, [id, JSON.stringify(context), JSON.stringify(result), claimToken]);

        if (saved.rowCount) {
          console.log("Analyse pré-calculée :", id, matchText);
        } else {
          console.warn("Résultat pré-calculé ignoré : réservation perdue pour", id);
        }
      } catch (error) {
        await analysisQuery(`
          UPDATE match_analyses
          SET status = 'error', updated_at = NOW()
          WHERE event_id = $1
            AND status = 'processing'
            AND claim_token = $2
        `, [id, claimToken]).catch(() => {});

        console.error("Pré-calcul impossible pour", id, error.message);
      }

      // Une seule tentative de génération maximum par exécution.
      return;
    }

    console.log("Pré-calcul : aucun match à traiter pour le moment.");
  } catch (error) {
    console.error("Erreur du pré-calcul des matchs :", error.message);
  } finally {
    precomputeRunning = false;
  }
}

// Génération à la demande : le résultat est partagé entre tous les utilisateurs.
async function runOnDemandAnalysis(matchId, context, claimToken) {
  try {
    const result = await generateFootballAnalysis(context);

    const saved = await analysisQuery(`
      UPDATE match_analyses
      SET context = $2::jsonb,
          result = $3::jsonb,
          status = 'ready',
          generated_at = NOW(),
          updated_at = NOW()
      WHERE event_id = $1
        AND status = 'processing'
        AND claim_token = $4
    `, [matchId, JSON.stringify(context), JSON.stringify(result), claimToken]);

    if (saved.rowCount) {
      console.log("Analyse à la demande enregistrée :", matchId);
    } else {
      console.warn("Résultat non enregistré : réservation perdue pour", matchId);
    }
  } catch (error) {
    console.error("Analyse à la demande impossible :", matchId, error.message);

    try {
      await analysisQuery(`
        UPDATE match_analyses
        SET status = 'error', updated_at = NOW()
        WHERE event_id = $1
          AND status = 'processing'
          AND claim_token = $2
      `, [matchId, claimToken]);
    } catch (dbError) {
      console.error("Enregistrement de l'erreur impossible :", dbError.message);
    }
  }
}


// REWARDED_GPT_LOCAL_INTEGRATION_V1
async function ensureRewardedSessionsTable() {
  await analysisQuery(`
    CREATE TABLE IF NOT EXISTS rewarded_ad_sessions (
      id UUID PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'claimed', 'expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      claimed_at TIMESTAMPTZ
    )
  `);
  await analysisQuery(`
    CREATE INDEX IF NOT EXISTS idx_rewarded_sessions_user_created
    ON rewarded_ad_sessions(user_id, created_at DESC)
  `);
}

const rewardedRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de demandes de récompense. Réessaie plus tard." }
});

// Crée une session courte liée au compte connecté.
// Cette session protège contre les doubles réclamations, pas contre
// la falsification d'un événement envoyé par le navigateur.
app.post("/api/rewarded/start", requireAuth, rewardedRequestLimiter, async (req, res) => {
  if (req.user.role === "admin") {
    return res.status(400).json({
      error: "Les administrateurs disposent déjà d'analyses illimitées."
    });
  }

  try {
    const sessionId = require("node:crypto").randomUUID();
    const result = await analysisQuery(`
      INSERT INTO rewarded_ad_sessions (id, user_id, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '10 minutes')
      RETURNING id, expires_at
    `, [sessionId, req.user.id]);

    res.set("Cache-Control", "no-store");
    return res.status(201).json({
      ok: true,
      sessionId: result.rows[0].id,
      expiresAt: result.rows[0].expires_at
    });
  } catch (error) {
    console.error("Création session récompense impossible :", error.message);
    return res.status(500).json({
      error: "Impossible de démarrer la récompense."
    });
  }
});

// Réclame une session au maximum une fois. Le crédit et le changement
// d'état sont enregistrés dans une seule transaction PostgreSQL.
app.post("/api/rewarded/claim", requireAuth, rewardedRequestLimiter, async (req, res) => {
  const sessionId = String(req.body?.sessionId || "");
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(sessionId)) {
    return res.status(400).json({ error: "Session de récompense invalide." });
  }

  if (req.user.role === "admin") {
    return res.status(400).json({
      error: "Les administrateurs disposent déjà d'analyses illimitées."
    });
  }

  try {
    const outcome = await transaction(async client => {
      const found = await client.query(`
        SELECT id, status, expires_at
        FROM rewarded_ad_sessions
        WHERE id = $1 AND user_id = $2
        FOR UPDATE
      `, [sessionId, req.user.id]);

      const session = found.rows[0];
      if (!session) return "invalid";
      if (session.status !== "pending") return "already_used";

      const expiry = await client.query(
        "SELECT ($1::timestamptz > NOW()) AS valid",
        [session.expires_at]
      );

      if (!expiry.rows[0]?.valid) {
        await client.query(`
          UPDATE rewarded_ad_sessions
          SET status = 'expired'
          WHERE id = $1 AND status = 'pending'
        `, [sessionId]);
        return "expired";
      }

      await client.query(`
        UPDATE rewarded_ad_sessions
        SET status = 'claimed', claimed_at = NOW()
        WHERE id = $1 AND status = 'pending'
      `, [sessionId]);

      await client.query(`
        INSERT INTO reward_credits (user_id, credits)
        VALUES ($1, 1)
        ON CONFLICT (user_id)
        DO UPDATE SET credits = reward_credits.credits + 1
      `, [req.user.id]);

      return "claimed";
    });

    res.set("Cache-Control", "no-store");

    if (outcome === "claimed") {
      return res.json({
        ok: true,
        creditsAdded: 1,
        message: "Un crédit a été ajouté à ton compte."
      });
    }
    if (outcome === "already_used") {
      return res.status(409).json({ error: "Cette récompense a déjà été réclamée." });
    }
    if (outcome === "expired") {
      return res.status(410).json({ error: "La session de récompense a expiré." });
    }
    return res.status(404).json({ error: "Session de récompense introuvable." });
  } catch (error) {
    console.error("Réclamation récompense impossible :", error.message);
    return res.status(500).json({
      error: "Impossible d'enregistrer la récompense."
    });
  }
});


app.post("/analyze", requireAuth, async (req, res) => {
  const context = req.body?.context || {};
  const matchId = String(req.body?.matchId || "");

  if (!/^\d+$/.test(matchId)) {
    return res.status(400).json({ error: "Identifiant du match invalide." });
  }

  let quota;
  try {
    quota = await consumeAnalysisQuota(req.user);
  } catch (error) {
    console.error("Réservation du quota impossible :", error.message);
    return res.status(error.statusCode || 503).json({
      error: error.statusCode === 401
        ? "Connexion requise."
        : "Impossible de vérifier le quota pour le moment."
    });
  }

  if (!quota.allowed) {
    res.set("Cache-Control", "no-store");
    return res.status(429).json({
      error: "Tu as utilisé tes 3 analyses gratuites et tu n'as plus de crédit disponible.",
      quotaReached: true,
      freeRemaining: 0,
      creditsRemaining: 0
    });
  }

  const auditId = await recordAnalysisStart(req.user.id, context);
  if (!auditId) {
    return res.status(503).json({
      error: "Impossible d'enregistrer la demande d'analyse. Réessaie plus tard."
    });
  }

  try {
    const cached = await analysisQuery(`
      SELECT result, status
      FROM match_analyses
      WHERE event_id = $1
    `, [matchId]);

    const row = cached.rows[0];

    if (row?.status === "ready" && row.result) {
      await finishAnalysisEvent(auditId, "success");
      return res.json(row.result);
    }

    // Réservation atomique avec jeton unique pour protéger le résultat.
    // Une réservation bloquée depuis plus de 20 minutes peut être reprise.
    const claimToken = require("crypto").randomUUID();
    const claim = await analysisQuery(`
      INSERT INTO match_analyses
        (event_id, match_text, competition, match_date, context,
         status, claim_token, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, 'processing', $6, NOW())
      ON CONFLICT (event_id) DO UPDATE SET
        match_text = EXCLUDED.match_text,
        competition = EXCLUDED.competition,
        match_date = EXCLUDED.match_date,
        context = EXCLUDED.context,
        status = 'processing',
        claim_token = EXCLUDED.claim_token,
        updated_at = NOW()
      WHERE match_analyses.status <> 'ready'
        AND (
          match_analyses.status <> 'processing'
          OR match_analyses.updated_at < NOW() - INTERVAL '20 minutes'
        )
      RETURNING event_id
    `, [
      matchId,
      String(context.match || `Match ${matchId}`).slice(0, 500),
      String(context.championnat || "Football").slice(0, 200),
      String(context.date || ""),
      JSON.stringify(context),
      claimToken
    ]);

    if (claim.rowCount > 0) {
      void runOnDemandAnalysis(matchId, context, claimToken);
      console.log("Analyse à la demande démarrée :", matchId);
    } else {
      console.log("Analyse déjà en cours ou prête :", matchId);
    }

    return res.status(202).json({
      pending: true,
      matchId,
      auditId,
      message: "Analyse en préparation. Le résultat sera partagé dès qu'il sera prêt."
    });
  } catch (error) {
    await finishAnalysisEvent(auditId, "error");
    console.error("Demande d'analyse impossible :", error.message);
    return res.status(503).json({
      error: "Le stockage des analyses est temporairement indisponible."
    });
  }
});

app.post("/api/analysis/audit/:id/finish", requireAuth, async (req, res) => {
  const idText = String(req.params.id || "");
  const status = req.body?.status;

  if (!/^\d+$/.test(idText) ||
      !Number.isSafeInteger(Number(idText)) ||
      Number(idText) < 1 ||
      !["success", "error"].includes(status)) {
    return res.status(400).json({ error: "Paramètres de clôture invalides." });
  }

  const finalized = await finishAnalysisEventForUser(
    Number(idText),
    req.user.id,
    status
  );

  if (!finalized) {
    return res.status(503).json({
      error: "Impossible de mettre à jour le journal d'analyse."
    });
  }

  return res.json({ ok: true });
});

// Consultation du cache sans consommer un nouveau quota.
app.get("/api/analysis/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id || "").replace(/\D/g, "");
  if (!id) return res.status(400).json({ error: "Identifiant invalide." });

  try {
    const cached = await analysisQuery(`
      SELECT result, status, generated_at
      FROM match_analyses
      WHERE event_id = $1
    `, [id]);

    const row = cached.rows[0];

    if (row?.status === "ready" && row.result) {
      return res.json({
        ready: true,
        result: row.result,
        generatedAt: row.generated_at
      });
    }

    if (row?.status === "error") {
      return res.json({
        ready: false,
        pending: false,
        error: "La génération de l'analyse a échoué. Tu peux réessayer."
      });
    }

    return res.json({ ready: false, pending: true });
  } catch (error) {
    console.error("Lecture du cache impossible :", error.message);
    return res.status(503).json({ error: "Cache temporairement indisponible." });
  }
});



// ============================================================
// API ZOUZOUA — DONNÉES FOOTBALL
// ============================================================

const ESPN_SOCCER_API =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/all";

const espnCache = new Map();
const ESPN_CACHE_TTL = 60 * 1000;

async function fetchESPN(url) {
  const cached = espnCache.get(url);
  const now = Date.now();

  if (cached && now - cached.time < ESPN_CACHE_TTL) {
    return cached.data;
  }

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Zouzoua-Pronostic/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`ESPN HTTP ${response.status}`);
  }

  const data = await response.json();

  espnCache.set(url, {
    time: now,
    data
  });

  return data;
}

// État du serveur
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Zouzoua Pronostic",
    api: "football",
    timestamp: new Date().toISOString()
  });
});

// Liste des matchs.
// Sans paramètre : hier + aujourd'hui + demain.
// Avec ?date=YYYYMMDD : une seule date.
app.get("/api/matches", async (req, res) => {
  try {
    const requestedDate = String(req.query.date || "").trim();

    let dates;

    if (requestedDate) {
      const date = requestedDate.replace(/\D/g, "");

      if (!/^\d{8}$/.test(date)) {
        return res.status(400).json({
          ok: false,
          error: "Date invalide. Format attendu : YYYYMMDD."
        });
      }

      dates = [date];

    } else {
      const now = new Date();

      dates = [-1, 0, 1].map(offset => {
        const d = new Date(now);
        d.setDate(d.getDate() + offset);

        return [
          d.getFullYear(),
          String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0")
        ].join("");
      });
    }

    const results = await Promise.all(
      dates.map(date =>
        fetchESPN(
          `${ESPN_SOCCER_API}/scoreboard?dates=${date}`
        )
      )
    );

    const events = new Map();

    for (const data of results) {
      for (const event of data.events || []) {
        if (event?.id) {
          events.set(String(event.id), event);
        }
      }
    }

    const list = [...events.values()].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    res.json({
      ok: true,
      dates,
      count: list.length,
      events: list
    });

  } catch (error) {
    console.error("Erreur /api/matches :", error.message);

    res.status(502).json({
      ok: false,
      error: "Impossible de récupérer les matchs."
    });
  }
});

// Un match précis.
// Exemple : /api/matches/401882844
app.get("/api/matches/:id", async (req, res) => {
  try {
    const id = String(req.params.id).replace(/\D/g, "");

    if (!id) {
      return res.status(400).json({
        error: "ID de match invalide."
      });
    }

    const data = await fetchESPN(
      `${ESPN_SOCCER_API}/summary?event=${id}`
    );

    const event =
      data.header?.competitions?.[0] ||
      data.header ||
      null;

    res.json({
      ok: true,
      id,
      event,
      summary: data
    });

  } catch (error) {
    console.error("Erreur /api/matches/:id :", error.message);

    res.status(502).json({
      ok: false,
      error: "Impossible de récupérer le match."
    });
  }
});

// Résumé détaillé d'un match.
// Exemple : /api/matches/401882844/summary
app.get("/api/matches/:id/summary", async (req, res) => {
  try {
    const id = String(req.params.id).replace(/\D/g, "");

    if (!id) {
      return res.status(400).json({
        error: "ID de match invalide."
      });
    }

    const data = await fetchESPN(
      `${ESPN_SOCCER_API}/summary?event=${id}`
    );

    res.json({
      ok: true,
      id,
      boxscore: data.boxscore || null,
      lastFiveGames: data.lastFiveGames || [],
      leaders: data.leaders || [],
      standings: data.standings || [],
      pickcenter: data.pickcenter || null,
      odds: data.odds || [],
      header: data.header || null
    });

  } catch (error) {
    console.error(
      "Erreur /api/matches/:id/summary :",
      error.message
    );

    res.status(502).json({
      ok: false,
      error: "Impossible de récupérer le résumé du match."
    });
  }
});

app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("Zouzoua local lancé sur http://localhost:3000");

  // Initialisation du stockage puis préparation des matchs.
  ensureRewardedSessionsTable()
    .then(() => ensureMatchAnalysesTable())
    .then(() => precomputeUpcomingMatches())
    .catch(error => console.error("Initialisation des analyses impossible :", error.message));

  // Actualisation périodique lorsque le service est actif.
  setInterval(() => {
    precomputeUpcomingMatches().catch(error =>
      console.error("Pré-calcul périodique impossible :", error.message)
    );
  }, 60 * 1000);
});
