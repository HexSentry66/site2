require("dotenv").config({ path: "./secrets/.env" });
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
// Clé chargée depuis secrets/.env
const NVIDIA_MODEL = 'openai/gpt-oss-20b';

function buildPrompt(ctx) {
  return `Tu es un analyste football professionnel francophone spécialisé dans les analyses d'avant-match. Tu écris toujours en français.

À partir uniquement des données fournies, rédige une analyse complète comme un article sportif.

DONNÉES DU MATCH :
${JSON.stringify(ctx)}

IMPORTANT : Réponds uniquement en français. N'utilise jamais l'anglais. Réponds UNIQUEMENT avec un JSON valide suivant exactement cette structure :

{
 "titre": "Analyse complète du match Équipe A vs Équipe B en français",

 "facteurs_importants": [
   {
    "numero": 1,
    "titre": "Titre du facteur",
    "contenu": "Analyse détaillée en plusieurs phrases avec les statistiques importantes."
   }
 ],

 "comparaison": {
   "colonnes": ["Indicateur","Équipe domicile","Équipe extérieure"],
   "lignes": [
     ["Forme récente","...","..."],
     ["Buts marqués","...","..."],
     ["Buts encaissés","...","..."]
   ]
 },

 "conclusion": "Résumé neutre expliquant les forces, faiblesses et incertitudes du match.",

 "scenarios": [
   {
    "numero":1,
    "titre":"Premier scénario à surveiller",
    "analyse":"Explication détaillée du scénario et des statistiques qui le soutiennent."
   },
   {
    "numero":2,
    "titre":"Deuxième scénario à surveiller",
    "analyse":"Explication détaillée du scénario et des statistiques qui le soutiennent."
   },
   {
    "numero":3,
    "titre":"Troisième scénario à surveiller",
    "analyse":"Explication détaillée du scénario et des statistiques qui le soutiennent."
   }
 ],

 "bilan_final": "Mon bilan footballistique : résumé de l'analyse, dynamique des équipes, absences, avantages et risques. Aucun scénario ne garantit le résultat."
}

Règles obligatoires :
- Toutes les clés et toutes les valeurs doivent être en français.
- Ne jamais inventer des blessures ou statistiques absentes.
- Garder un ton professionnel similaire à un analyste Opta.
- Ne pas donner de certitude absolue.
- Chaque facteur doit contenir une vraie explication.
- Les scénarios doivent être basés sur les données.
- Répondre uniquement en JSON valide sans markdown.`;
}

function extractJSON(text) {
  if (!text) throw new Error('Réponse vide du modèle');
  const cleaned = text.replace(/```json|```/g, '');
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('Réponse du modèle illisible');
  return JSON.parse(cleaned.slice(start, end + 1));
}

router.get('/', async () => ({ ok: true, service: 'Zouzoua Pronostic - analyse' }));

router.post('/analyze', async ({ request }) => {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Requête invalide' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  const ctx = body && body.context;
  if (!ctx || typeof ctx !== 'object') return new Response(JSON.stringify({ error: 'Données du match manquantes' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const ctxStr = JSON.stringify(ctx);
  if (ctxStr.length > 60000) return new Response(JSON.stringify({ error: 'Données trop volumineuses' }), { status: 413, headers: { 'Content-Type': 'application/json' } });

  let lastErr = 'Erreur inconnue';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(NVIDIA_BASE_URL + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.NVIDIA_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          model: NVIDIA_MODEL,
          messages: [
            { role: 'system', content: 'Tu es un analyste football. Tu réponds toujours en français et uniquement en JSON valide.' },
            { role: 'user', content: buildPrompt(ctx) }
          ],
          temperature: 0.6,
          top_p: 0.95,
          max_tokens: 4096,
          stream: false
        })
      });
      const raw = await r.text();
      if (!r.ok) { lastErr = 'Erreur API NVIDIA (' + r.status + ') : ' + raw.slice(0, 300); if (r.status < 500) break; continue; }
      const data = JSON.parse(raw);
      const msg = data.choices && data.choices[0] && data.choices[0].message || {};
      const content = msg.content || msg.reasoning_content || '';
      let result = extractJSON(content);

      // Conversion format NVIDIA -> format Zouzoua
      if (!result.scenarios && result.predicted_outcome) {
        result = {
          resume: result.summary || '',
          scenarios: [
            {
              titre: result.predicted_outcome,
              issue: '1',
              probabilite: 50,
              score_probable: '',
              total_buts: '',
              deux_equipes_marquent: '',
              deroulement: result.summary || '',
              facteurs_cles: result.key_factors || []
            }
          ],
          points_attention: result.risk_factors || [],
          confiance: result.confidence || 'Moyenne'
        };
      }
      if (!Array.isArray(result.scenarios) || !result.scenarios.length) throw new Error('Aucun scénario retourné');
      result.model = NVIDIA_MODEL;
      return result;
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return new Response(JSON.stringify({ error: lastErr }), { status: 502, headers: { 'Content-Type': 'application/json' } });
});
