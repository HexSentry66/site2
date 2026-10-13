const express = require("express");
const cors = require("cors");
require("dotenv").config({ path: "./secrets/.env" });

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("."));

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODEL = "openai/gpt-oss-20b";

app.post("/analyze", async (req, res) => {
  try {
    const response = await fetch(NVIDIA_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.NVIDIA_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [
          {
            role: "system",
            content: `Tu es un analyste football professionnel francophone.

Analyse uniquement les données fournies.
Ne jamais inventer des statistiques absentes.
Réponds uniquement avec un JSON valide.

Format obligatoire :

{
"resume":"Résumé clair du rapport de force",
"scenarios":[
{
"titre":"Scénario principal",
"issue":"1|N|2",
"probabilite":50,
"score_probable":"",
"deroulement":"Explication",
"facteurs_cles":["facteur 1","facteur 2"]
},
{
"titre":"Scénario secondaire",
"issue":"1|N|2",
"probabilite":30,
"score_probable":"",
"deroulement":"Explication",
"facteurs_cles":["facteur"]
}
],
"points_attention":["risque 1","risque 2"],
"confiance":"Faible|Moyenne|Élevée"
}`
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

    const data = await response.json();

    console.log("===== REPONSE NVIDIA COMPLETE =====");
    console.log(JSON.stringify(data, null, 2));
    console.log("===== FIN REPONSE NVIDIA =====");
    res.json(data);

  } catch (error) {
    res.status(500).json({error:error.message});
  }
});

app.listen(3000, () => {
  console.log("Zouzoua local lancé sur http://localhost:3000");
});
