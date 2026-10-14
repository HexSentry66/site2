// Rotation NVIDIA round-robin pour deux clés.
// Les clés restent exclusivement dans les variables d'environnement.

const ENV_NAMES = [
  "NVIDIA_API_KEY_1",
  "NVIDIA_API_KEY_2",
];

let nextIndex = 0;
let previousIndex = -1;

function readKeys() {
  const keys = ENV_NAMES.map((name) => {
    const value = process.env[name];
    return typeof value === "string" ? value.trim() : "";
  });

  if (keys.some((key) => !key)) {
    throw new Error("Les deux clés NVIDIA doivent être configurées.");
  }

  if (new Set(keys).size !== keys.length) {
    throw new Error("Les deux variables NVIDIA doivent contenir des clés distinctes.");
  }

  return keys;
}

function validateKeys() {
  readKeys();
}

function getNextKey() {
  const keys = readKeys();
  let index = nextIndex;

  if (index === previousIndex) {
    index = (index + 1) % keys.length;
  }

  previousIndex = index;
  nextIndex = (index + 1) % keys.length;
  return keys[index];
}

module.exports = { validateKeys, getNextKey };
