const API_KEY = process.env.NVIDIA_API_KEY;

const match = {
  home_team: "Paris Saint-Germain",
  away_team: "Olympique de Marseille",
  competition: "Ligue 1",
  date: "2026-10-13",
  home_form: ["W","W","D","W","L"],
  away_form: ["W","D","W","L","D"],
  home_goals_avg: 2.1,
  away_goals_avg: 1.4,
  home_position: 2,
  away_position: 6,
  injuries: [],
  h2h: [
    "PSG 3-1 OM",
    "OM 0-2 PSG",
    "PSG 1-1 OM"
  ]
};

fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
  method:"POST",
  headers:{
    "Authorization":"Bearer "+API_KEY,
    "Content-Type":"application/json"
  },
  body:JSON.stringify({
    model:"openai/gpt-oss-20b",
    messages:[
      {
        role:"system",
        content:"Tu es l'analyste football de Zouzoua. Réponds uniquement en JSON valide."
      },
      {
        role:"user",
        content:`Analyse ce match : ${JSON.stringify(match)}`
      }
    ],
    temperature:0.6,
    max_tokens:1000
  })
})
.then(r=>r.json())
.then(data=>{
 console.log(JSON.stringify(data,null,2));
})
.catch(console.error);
