const express = require("express");
const path = require("node:path");
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config({ path: path.join(__dirname, "secrets", ".env") });
}

const app = express();

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
const { attachAuth, enforceDailyQuota, recordAnalysisStart, finishAnalysisEvent } = require("./auth");
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

app.post("/analyze", requireAuth, enforceDailyQuota, async (req, res) => {
  const auditId = await recordAnalysisStart(req.user.id, req.body?.context);
  try {
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

Analyse uniquement les données fournies.
Ne jamais inventer de statistiques absentes.

Ton objectif est de sélectionner les pronostics les plus pertinents pour ce match.

Tu dois choisir toi-même les marchés adaptés selon les informations disponibles.

Ne force jamais un marché qui n'est pas suffisamment justifié.

Réponds uniquement avec un JSON valide.

Format obligatoire :

{
"resume":"Résumé professionnel du rapport de force entre les deux équipes.",

"pronostics":[
{
"marche":"Nom du marché",
"choix":"Pronostic sélectionné",
"probabilite":"Pourcentage estimé",
"confiance":"Faible|Moyenne|Élevée",
"explication":"Explication basée uniquement sur les données disponibles."
}
],

"bilan_final":"Synthèse finale des meilleures opportunités et des risques. Aucun pronostic n'est garanti."
}

Règles obligatoires :
- Donner exactement 3 pronostics.
- Classer les pronostics du plus intéressant au moins intéressant.
- Utiliser uniquement les marchés réellement justifiés.
- Ne jamais inventer de données.
- Ne jamais donner de certitude absolue.
- Répondre uniquement en JSON sans markdown.`

          },
          {
            role: "user",
            content: JSON.stringify(req.body.context)
          }
        ],
        temperature: 0.6,
        max_tokens: 4096
      })
    });

    if (!response.ok) {
      await finishAnalysisEvent(auditId, "error");
      console.error("Erreur NVIDIA HTTP :", response.status);
      return res.status(502).json({
        error: "Le service d’analyse est momentanément indisponible."
      });
    }

    let data;
    try {
      data = await response.json();
    } catch {
      await finishAnalysisEvent(auditId, "error");
      return res.status(502).json({
        error: "Réponse invalide du service d’analyse."
      });
    }

    const content = data.choices?.[0]?.message?.content || "";

    let result;
    try {
      const start = content.indexOf("{");
      const end = content.lastIndexOf("}");

      result = JSON.parse(content.slice(start, end + 1));

    } catch (e) {
      console.error("Réponse IA non exploitable :", e.message);
      await finishAnalysisEvent(auditId, "error");
      return res.status(502).json({ error: "Réponse IA non exploitable." });
    }

    await finishAnalysisEvent(auditId, "success");
    res.json(result);

  } catch (error) {
    await finishAnalysisEvent(auditId, "error");
    console.error("Erreur service analyse :", error.message);
    res.status(500).json({ error: "Le service d’analyse est momentanément indisponible." });
  }
});

app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("Zouzoua local lancé sur http://localhost:3000");
});
