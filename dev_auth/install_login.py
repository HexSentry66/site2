from pathlib import Path
import shutil

html_path = Path("index.html")
js_path = Path("app.stable.js")
html = html_path.read_text()
js = js_path.read_text()

if 'id="authScreen"' in html or 'async function initAuth()' in js:
    raise SystemExit("L'écran de connexion semble déjà installé. Arrêt par sécurité.")

if 'const ANALYZE_URL' not in js or 'async function renderAuth()' not in js:
    raise SystemExit("Structure inattendue. Aucun fichier modifié.")

if not Path("index.html.before-login-ui").exists():
    shutil.copy2(html_path, "index.html.before-login-ui")
if not Path("app.stable.js.before-login-ui").exists():
    shutil.copy2(js_path, "app.stable.js.before-login-ui")

shell = '<div class="flex flex-col h-full">'
if shell not in html:
    raise SystemExit("Conteneur principal introuvable.")
html = html.replace(shell, '<div id="appShell" class="hidden flex flex-col h-full">', 1)

marker = '<script type="module" src="app.stable.js"></script>'
if marker not in html:
    raise SystemExit("Script principal introuvable.")

overlay = """
<div id="authScreen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-base">
  <div class="w-full max-w-md rounded-2xl border border-line bg-panel p-6 sm:p-8 shadow-2xl">
    <div class="flex items-center gap-3 mb-7">
      <img src="icon.svg" class="w-12 h-12" alt="Zouzoua Pronostic">
      <div>
        <h1 class="text-xl font-bold">Zouzoua <span class="text-accent">Pronostic</span></h1>
        <p class="text-sm text-gray-400">Connecte-toi pour continuer</p>
      </div>
    </div>
    <div class="flex rounded-lg bg-base p-1 mb-5">
      <button id="loginMode" type="button" class="flex-1 rounded-md py-2 text-sm font-semibold bg-accent text-[#052e1f]">Connexion</button>
      <button id="registerMode" type="button" class="flex-1 rounded-md py-2 text-sm font-semibold text-gray-400">Créer un compte</button>
    </div>
    <form id="authForm" class="space-y-4">
      <div>
        <label for="authPhone" class="block text-sm mb-2">Numéro de téléphone</label>
        <input id="authPhone" name="phone" type="tel" autocomplete="tel" required
          placeholder="+2250700000000"
          class="w-full h-11 rounded-lg bg-base border border-line px-3 text-sm outline-none focus:border-accent">
      </div>
      <div>
        <label for="authPassword" class="block text-sm mb-2">Mot de passe</label>
        <input id="authPassword" name="password" type="password" autocomplete="current-password"
          minlength="8" maxlength="128" required placeholder="8 caractères minimum"
          class="w-full h-11 rounded-lg bg-base border border-line px-3 text-sm outline-none focus:border-accent">
      </div>
      <p id="authMessage" role="status" aria-live="polite" class="hidden text-sm text-red-400"></p>
      <button id="authSubmit" type="submit"
        class="w-full h-11 rounded-lg bg-accent text-[#052e1f] font-bold text-sm hover:bg-emerald-400 disabled:opacity-60">Se connecter</button>
    </form>
    <p class="text-xs text-gray-500 mt-5 leading-relaxed">
      Les pronostics sont des estimations. Le numéro ne sera pas vérifié par SMS pour le moment.
    </p>
  </div>
</div>
"""
html = html.replace(marker, overlay + "\n" + marker, 1)

start = js.find("/* ---------- Auth ---------- */")
end = js.find("/* ---------- Init ---------- */")
if start < 0 or end < 0 or end <= start:
    raise SystemExit("Sections Auth/Init introuvables.")

auth_code = r'''
/* ---------- Authentification locale ---------- */
let authenticated = false;
let authMode = 'login';

function showAuthMessage(message, error = true) {
  const el = $('#authMessage');
  el.textContent = message;
  el.classList.remove('hidden', 'text-red-400', 'text-emerald-400');
  el.classList.add(error ? 'text-red-400' : 'text-emerald-400');
}

function setAuthMode(mode) {
  authMode = mode;
  const login = mode === 'login';
  $('#loginMode').className = 'flex-1 rounded-md py-2 text-sm font-semibold ' +
    (login ? 'bg-accent text-[#052e1f]' : 'text-gray-400');
  $('#registerMode').className = 'flex-1 rounded-md py-2 text-sm font-semibold ' +
    (!login ? 'bg-accent text-[#052e1f]' : 'text-gray-400');
  $('#authSubmit').textContent = login ? 'Se connecter' : 'Créer mon compte';
  $('#authPassword').autocomplete = login ? 'current-password' : 'new-password';
  $('#authMessage').classList.add('hidden');
}

function enterApp() {
  authenticated = true;
  $('#authScreen').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  $('#authBox').innerHTML =
    '<button id="signOut" class="h-9 px-3 rounded-lg border border-line hover:bg-panel text-sm">Déconnexion</button>';
  $('#signOut').onclick = async () => {
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      authenticated = false;
      state.analyses = {};
      $('#appShell').classList.add('hidden');
      $('#authScreen').classList.remove('hidden');
      $('#authPassword').value = '';
      setAuthMode('login');
      showAuthMessage('Tu es déconnecté.', false);
    }
  };
  loadMatches();
  icons_();
}

async function initAuth() {
  $('#loginMode').onclick = () => setAuthMode('login');
  $('#registerMode').onclick = () => setAuthMode('register');

  $('#authForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('#authSubmit');
    submit.disabled = true;
    submit.textContent = 'Patiente…';
    $('#authMessage').classList.add('hidden');

    try {
      const response = await fetch(authMode === 'login' ? '/api/login' : '/api/register', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: $('#authPhone').value.trim(),
          password: $('#authPassword').value
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Authentification impossible.');
      $('#authPassword').value = '';
      enterApp();
    } catch (error) {
      showAuthMessage(error.message || 'Connexion impossible.');
    } finally {
      submit.disabled = false;
      submit.textContent = authMode === 'login' ? 'Se connecter' : 'Créer mon compte';
    }
  });

  try {
    const response = await fetch('/api/me', { credentials: 'same-origin' });
    if (response.ok) {
      enterApp();
      return;
    }
  } catch (error) {
    console.error('Vérification de session impossible :', error);
  }
  $('#appShell').classList.add('hidden');
  $('#authScreen').classList.remove('hidden');
  icons_();
}

'''
js = js[:start] + auth_code + js[end:]

# Supprimer l'ancienne connexion Puter et son stockage d'analyses
js = js.replace(
    "    if (puter.auth.isSignedIn()) { try { await puter.kv.set('analysis_' + m.id, JSON.stringify(json)); } catch {} }\n",
    ""
)

old_init = """/* ---------- Init ---------- */
$('#search').oninput = (e) => { state.filter = e.target.value; renderList(); };
$('#leagueFilter').onchange = (e) => { state.league = e.target.value; renderList(); };
$('#refreshBtn').onclick = loadMatches;
icons_();
renderAuth();
loadMatches();
setInterval(loadMatches, 10 * 60 * 1000);
"""
new_init = """/* ---------- Init ---------- */
$('#search').oninput = (e) => { state.filter = e.target.value; renderList(); };
$('#leagueFilter').onchange = (e) => { state.league = e.target.value; renderList(); };
$('#refreshBtn').onclick = () => { if (authenticated) loadMatches(); };
icons_();
initAuth();
setInterval(() => { if (authenticated) loadMatches(); }, 10 * 60 * 1000);
"""
if old_init not in js:
    raise SystemExit("Bloc Init inattendu. Aucun fichier écrit.")

# Vérifications faites avant toute écriture
html_path.write_text(html)
js_path.write_text(js)
print("Écran de connexion installé.")
print("Sauvegardes créées : index.html.before-login-ui, app.stable.js.before-login-ui")
