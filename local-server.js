require("dotenv").config({ path: "./secrets/.env" });

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.use((req,res,next)=>{
 console.log("REQUETE RECUE :", req.method, req.url);
 next();
});
app.use(express.static("."));

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODEL = "openai/gpt-oss-20b";

app.get("/", (req,res)=>{
  res.json({
    ok:true,
    service:"Zouzoua Pronostic local"
  });
});

app.post("/analyze", async (req,res)=>{
  try {

    const r = await fetch(NVIDIA_BASE_URL + "/chat/completions", {
      method:"POST",
      headers:{
        "Authorization":"Bearer " + process.env.NVIDIA_API_KEY,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        model:NVIDIA_MODEL,
        messages:[
          {
            role:"system",
            content:"Tu es un analyste football expert. Réponds uniquement en JSON."
          },
          {
            role:"user",
            content:JSON.stringify(req.body.context)
          }
        ],
        temperature:0.6,
        max_tokens:4096
      })
    });

    const data = await r.json();

    console.log("=== REPONSE NVIDIA ===");
    console.log(JSON.stringify(data, null, 2));
    console.log("======================");

    res.json(data);

  } catch(e){
    res.status(500).json({
      error:e.message
    });
  }
});

app.listen(3000,'0.0.0.0',()=>{
 console.log("🚀 Zouzoua local : http://localhost:3000");
});
