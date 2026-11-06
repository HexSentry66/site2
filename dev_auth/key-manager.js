// Gestion de la clé Groq.
// La clé reste exclusivement dans les variables d'environnement.

function getNextKey() {
  const key = process.env.GROQ_API_KEY;

  if (typeof key !== "string" || !key.trim()) {
    throw new Error("La variable GROQ_API_KEY doit être configurée.");
  }

  return key.trim();
}

function validateKeys() {
  getNextKey();
}

module.exports = { validateKeys, getNextKey };
