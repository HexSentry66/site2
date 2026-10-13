const API_KEY = "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";

fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer " + API_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "openai/gpt-oss-20b",
    messages: [
      {
        role: "user",
        content: "Réponds simplement : API NVIDIA fonctionnelle."
      }
    ],
    max_tokens: 50
  })
})
.then(r => r.text())
.then(console.log)
.catch(console.error);
