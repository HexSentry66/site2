const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
// Clé chargée depuis config/api-config.js
const NVIDIA_MODEL = 'openai/gpt-oss-20b';

function buildPrompt(ctx) {
  return `Tu es un analyste football expert. À partir des données d'avant-match ci-dessous (JSON), propose exactement 3 scénarios plausibles et distincts pour ce match. Base-toi sur les données fournies (forme, stats, confrontations, classement, cotes, absences) et ta connaissance générale des équipes. Les probabilités des 3 scénarios doivent totaliser 100.

DONNÉES:
${JSON.stringify(ctx)}

Réponds UNIQUEMENT avec un JSON valide (sans markdown, sans texte autour) au format :
{
 "resume": "synthèse en 2-3 phrases du rapport de force",
 "scenarios": [
   {"titre": "titre court", "issue": "1|N|2", "probabilite": 45, "score_probable": "2-1", "total_buts": "Plus de 2.5", "deux_equipes_marquent": "Oui|Non", "deroulement": "récit du déroulé du match en 3-4 phrases", "facteurs_cles": ["facteur 1","facteur 2","facteur 3"]}
 ],
 "points_attention": ["point 1","point 2"],
 "confiance": "Faible|Moyenne|Élevée"
}`;
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
        headers: { 'Authorization': 'Bearer ' + env.NVIDIA_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
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
      const result = extractJSON(content);
      if (!Array.isArray(result.scenarios) || !result.scenarios.length) throw new Error('Aucun scénario retourné');
      result.model = NVIDIA_MODEL;
      return result;
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return new Response(JSON.stringify({ error: lastErr }), { status: 502, headers: { 'Content-Type': 'application/json' } });
});
