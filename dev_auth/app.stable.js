import { createIcons, icons } from 'https://cdn.jsdelivr.net/npm/lucide@latest/+esm';

const API = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all';
// Adresse du service d'analyse privé (utilise VOTRE clé API, stockée côté serveur uniquement)
const ANALYZE_URL = window.location.origin;
const state = { matches: [], selected: null, summaries: {}, analyses: {}, filter: '', league: '' };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons_ = () => createIcons({ icons });
const isMobile = () => window.innerWidth < 768;

/* ---------- Helpers ---------- */
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const fmtTime = (d) => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => {
  const today = new Date(); const tm = new Date(); tm.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === tm.toDateString()) return 'Demain';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
};
const fmtFull = (d) => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' · ' + fmtTime(d);
const countdown = (d) => {
  const ms = d - Date.now(); if (ms <= 0) return 'En cours';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h ? `dans ${h}h${String(m).padStart(2, '0')}` : `dans ${m} min`;
};
const americanToDecimal = (o) => {
  if (o == null || o === '') return null; const n = parseFloat(String(o).replace('+', ''));
  if (isNaN(n)) return null; return (n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1).toFixed(2);
};

async function getJSON(url) {
  try {
    const r = await fetch(url); if (!r.ok) throw new Error(r.status); return await r.json();
  } catch (e) {
    if (window.puter?.net?.fetch) { const r = await puter.net.fetch(url); return await r.json(); }
    throw e;
  }
}

/* ---------- Data ---------- */
function parseEvent(ev) {
  const c = ev.competitions?.[0] || {};
  const home = c.competitors?.find(t => t.homeAway === 'home') || c.competitors?.[0];
  const away = c.competitors?.find(t => t.homeAway === 'away') || c.competitors?.[1];
  const team = (t) => ({
    id: t?.team?.id, name: t?.team?.displayName, short: t?.team?.shortDisplayName, abbr: t?.team?.abbreviation,
    logo: t?.team?.logo, form: t?.form || '', record: t?.records?.[0]?.summary || '', score: t?.score,
    leader: t?.leaders?.[0]?.leaders?.[0] ? `${t.leaders[0].leaders[0].athlete?.displayName} (${t.leaders[0].leaders[0].displayValue} buts)` : ''
  });
  const odds = c.odds?.[0];
  return {
    id: ev.id, date: new Date(ev.date), name: ev.name,
    league: c.altGameNote || ev.season?.slug?.replace(/^\d{4}(-\d{2})?-/, '').replace(/-/g, ' ') || 'Football',
    leagueSlug: ev.uid?.split('~')[1] || '',
    state: c.status?.type?.state, status: c.status?.type?.shortDetail || c.status?.type?.description, clock: c.status?.displayClock,
    venue: c.venue?.fullName || ev.venue?.displayName || 'Stade non communiqué',
    city: [c.venue?.address?.city, c.venue?.address?.country].filter(Boolean).join(', '),
    broadcasts: (c.broadcasts || []).flatMap(b => b.names || []),
    home: team(home), away: team(away),
    odds: odds ? {
      provider: odds.provider?.name, overUnder: odds.overUnder,
      home: americanToDecimal(odds.moneyline?.home?.close?.odds), draw: americanToDecimal(odds.moneyline?.draw?.close?.odds),
      away: americanToDecimal(odds.moneyline?.away?.close?.odds),
      over: americanToDecimal(odds.total?.over?.close?.odds), under: americanToDecimal(odds.total?.under?.close?.odds)
    } : null
  };
}

async function loadMatches() {
  const list = $('#matchList');
  list.innerHTML = Array.from({ length: 8 }, () => `<div class="p-4 border-b border-line"><div class="skel h-3 w-24 mb-3"></div><div class="skel h-4 w-3/4 mb-2"></div><div class="skel h-4 w-2/3"></div></div>`).join('');
  $('#refreshBtn svg')?.classList.add('spin');
  try {
    const now = new Date(); const days = [-1, 0, 1].map(o => { const d = new Date(now); d.setDate(d.getDate() + o); return ymd(d); });
    const res = await Promise.allSettled(days.map(d => getJSON(`${API}/scoreboard?dates=${d}`)));
    const map = new Map();
    res.forEach(r => r.status === 'fulfilled' && (r.value.events || []).forEach(ev => map.set(ev.id, ev)));
    const limit = now.getTime() + 24 * 3600000;
    state.matches = [...map.values()].map(parseEvent)
      .filter(m => (m.state === 'pre' && m.date.getTime() <= limit && m.date.getTime() >= now.getTime() - 5 * 60000) || m.state === 'in')
      .sort((a, b) => a.date - b.date);
    const leagues = [...new Set(state.matches.map(m => m.league))].sort();
    const sel = $('#leagueFilter'); const cur = sel.value;
    sel.innerHTML = `<option value="">Tous les championnats (${leagues.length})</option>` + leagues.map(l => `<option ${l === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
    $('#lastUpdate').textContent = 'Mis à jour à ' + fmtTime(new Date());
    renderList();
    if (!state.selected && !isMobile()) renderEmpty();
  } catch (e) {
    list.innerHTML = `<div class="p-8 text-center text-sm text-gray-400"><i data-lucide="wifi-off" class="w-6 h-6 mx-auto mb-2"></i>Impossible de récupérer les matchs.<br><button onclick="location.reload()" class="mt-3 text-accent">Réessayer</button></div>`;
    icons_();
  } finally { $('#refreshBtn svg')?.classList.remove('spin'); }
}

/* ---------- List ---------- */
function formBadges(form, size = 'w-4 h-4 text-[9px]') {
  if (!form) return '<span class="text-xs text-gray-600">—</span>';
  return `<div class="flex gap-0.5">${form.split('').map(r => `<span class="form-${r} ${size} rounded-sm grid place-items-center font-bold">${r === 'W' ? 'V' : r === 'L' ? 'D' : 'N'}</span>`).join('')}</div>`;
}
const logo = (t, cls = 'w-6 h-6') => t.logo ? `<img src="${esc(t.logo)}" class="${cls} object-contain" loading="lazy" onerror="this.style.visibility='hidden'">` : `<div class="${cls} rounded-full bg-line"></div>`;

function renderList() {
  const q = state.filter.toLowerCase();
  const items = state.matches.filter(m => (!state.league || m.league === state.league) &&
    (!q || [m.home.name, m.away.name, m.league, m.venue].join(' ').toLowerCase().includes(q)));
  $('#countLabel').textContent = items.length;
  const list = $('#matchList');
  if (!items.length) {
    list.innerHTML = `<div class="p-10 text-center text-sm text-gray-400"><i data-lucide="calendar-x" class="w-7 h-7 mx-auto mb-3 text-gray-600"></i>Aucun match trouvé dans les prochaines 24h.</div>`;
    return icons_();
  }
  let html = '', lastDay = '', matchCount = 0;
  items.forEach(m => {
    const day = fmtDay(m.date);
    if (day !== lastDay) { html += `<div class="sticky top-0 z-10 bg-base/95 backdrop-blur px-4 py-2 text-[11px] uppercase tracking-wider text-gray-500 font-semibold border-b border-line">${esc(day)}</div>`; lastDay = day; }
    const live = m.state === 'in';
    matchCount++;
    html += `<button data-id="${m.id}" class="match-row w-full text-left px-4 py-3 border-b border-l-2 border-l-transparent border-line hover:bg-panel transition ${state.selected === m.id ? 'active' : ''}">
      <div class="flex items-center justify-between mb-2">
        <span class="text-[11px] text-gray-400 truncate pr-2 flex items-center gap-1.5"><i data-lucide="trophy" class="w-3 h-3"></i>${esc(m.league)}</span>
        ${live ? `<span class="text-[11px] font-semibold text-red-400 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>LIVE ${esc(m.clock)}</span>`
               : `<span class="text-xs font-semibold text-gray-200">${fmtTime(m.date)}</span>`}
      </div>
      <div class="space-y-1.5">
        ${[m.home, m.away].map(t => `<div class="flex items-center gap-2.5">${logo(t, 'w-5 h-5')}<span class="text-sm flex-1 truncate">${esc(t.name)}</span>${live ? `<span class="text-sm font-semibold">${esc(t.score)}</span>` : formBadges(t.form, 'w-3.5 h-3.5 text-[8px]')}</div>`).join('')}
      </div>
      <div class="mt-2 text-[11px] text-gray-500 flex items-center gap-1 truncate"><i data-lucide="map-pin" class="w-3 h-3 shrink-0"></i>${esc(m.venue)}</div>
    </button>`;
    if (matchCount % 5 === 0 && matchCount < items.length) {
      html += `<div class="p-3 border-b border-line" aria-label="Publicité">
        <ins class="adsbygoogle"
             style="display:block; min-height:100px"
             data-ad-format="fluid"
             data-ad-layout-key="-al+bk-2f-53+ik"
             data-ad-client="ca-pub-8143082489700562"
             data-ad-slot="1599955804"></ins>
      </div>`;
    }
  });
  list.innerHTML = html;
  list.querySelectorAll(".adsbygoogle").forEach(ad => {
    if (ad.dataset.adsbygoogleStatus) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
      console.warn("AdSense n'a pas pu initialiser ce bloc :", e);
    }
  });
  list.querySelectorAll('.match-row').forEach(b => b.onclick = () => selectMatch(b.dataset.id));
  icons_();
}

/* ---------- Publicité au-dessus des détails du match ---------- */
function showDetailAd() {
  const ad = document.getElementById("detailAd");
  if (!ad || ad.dataset.dismissed === "true") return;

  ad.classList.remove("hidden");
  ad.style.setProperty("display", "block", "important");
  ad.setAttribute("aria-hidden", "false");

  let fallback = document.getElementById("detailAdFallback");
  if (!fallback) {
    fallback = document.createElement("div");
    fallback.id = "detailAdFallback";
    fallback.className =
      "rounded-lg border border-dashed border-gray-600 bg-panel px-4 py-5 text-center text-sm text-gray-400";
    fallback.textContent =
      "Emplacement publicitaire — annonce non disponible pour le moment.";
    const slot = ad.querySelector("ins.adsbygoogle");
    if (slot) slot.insertAdjacentElement("afterend", fallback);
    else ad.appendChild(fallback);
  }

  const slot = ad.querySelector("ins.adsbygoogle");
  const updateFallback = () => {
    const status = slot?.getAttribute("data-ad-status");
    const filled = status === "filled";
    fallback.style.setProperty("display", filled ? "none" : "block", "important");
  };

  updateFallback();

  if (slot && !slot.dataset.fallbackWatch) {
    slot.dataset.fallbackWatch = "true";
    const observer = new MutationObserver(updateFallback);
    observer.observe(slot, {
      attributes: true,
      attributeFilter: ["data-ad-status"]
    });
    setTimeout(updateFallback, 5000);
  } else {
    setTimeout(updateFallback, 5000);
  }

  if (!ad.dataset.initialized) {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      ad.dataset.initialized = "true";
    } catch (e) {
      console.warn("AdSense détail indisponible :", e);
    }
  }
}

function hideDetailAd() {
  const ad = document.getElementById("detailAd");
  if (!ad) return;

  ad.classList.add("hidden");
  ad.style.setProperty("display", "none", "important");
  ad.setAttribute("aria-hidden", "true");
}

document.getElementById("closeDetailAd")?.addEventListener("click", hideDetailAd);

/* ---------- Detail ---------- */
function renderEmpty() {
  $('#detail').innerHTML = `<div class="h-full grid place-items-center p-10 text-center">
    <div><div class="w-14 h-14 rounded-2xl bg-panel border border-line grid place-items-center mx-auto mb-4"><i data-lucide="mouse-pointer-click" class="w-6 h-6 text-accent"></i></div>
    <h2 class="font-semibold mb-1">Sélectionnez un match</h2>
    <p class="text-sm text-gray-400 max-w-sm">Consultez les statistiques d'avant-match puis lancez l'analyse IA pour obtenir 3 scénarios détaillés.</p></div></div>`;
  icons_();
}

async function selectMatch(id) {
  state.selected = id;
  document.querySelectorAll('.match-row').forEach(b => b.classList.toggle('active', b.dataset.id === id));
  if (isMobile()) { $('#listPane').classList.add('hidden'); $('#detailPane').classList.remove('hidden'); $('#detailPane').classList.add('flex'); }
  const m = state.matches.find(x => x.id === id);
  // Afficher la publicité à chaque sélection de match.
  const detailAd = document.getElementById("detailAd");
  if (detailAd) detailAd.dataset.dismissed = "false";
  showDetailAd();

  renderDetail(m, null);
  if (!state.summaries[id]) {
    try { state.summaries[id] = await getJSON(`${API}/summary?event=${id}`); } catch { state.summaries[id] = {}; }
  }
  if (state.selected === id) renderDetail(m, state.summaries[id]);
  if (!state.analyses[id] && puter.auth.isSignedIn()) {
    try { const saved = await puter.kv.get('analysis_' + id); if (saved && state.selected === id) { state.analyses[id] = typeof saved === 'string' ? JSON.parse(saved) : saved; renderAnalysis(m); } } catch {}
  }
}

function extractSummary(m, s) {
  const out = { teamStats: {}, lastFive: {}, h2h: [], standings: [], leaders: {}, injuries: {}, odds: m.odds };
  if (!s) return out;
  (s.boxscore?.teams || []).forEach(t => { out.teamStats[t.team?.id] = (t.statistics || []).map(x => ({ label: x.label || x.name, value: x.displayValue })); });
  (s.lastFiveGames || []).forEach(t => {
    out.lastFive[t.team?.id] = (t.events || []).map(e => ({
      date: e.gameDate, opp: e.opponent?.displayName, oppLogo: e.opponentLogo, atVs: e.atVs, score: e.score, res: e.gameResult,
      comp: e.leagueAbbreviation || e.competitionName
    }));
  });
  (s.headToHeadGames || []).forEach(g => (g.events || []).forEach(e => out.h2h.push({
    date: e.gameDate, score: e.score, home: e.homeTeamId, away: e.awayTeamId, hs: e.homeTeamScore, as: e.awayTeamScore, comp: e.leagueAbbreviation || e.competitionName
  })));
  const uniqH2H = new Map(); out.h2h.forEach(h => uniqH2H.set(h.date + h.score, h)); out.h2h = [...uniqH2H.values()].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6);
  (s.leaders || []).forEach(t => {
    out.leaders[t.team?.id] = (t.leaders || []).map(cat => ({ cat: cat.displayName, top: (cat.leaders || []).slice(0, 2).map(l => ({ name: l.athlete?.displayName, val: l.mainStat?.value || l.displayValue, pos: l.athlete?.position?.abbreviation })) })).filter(c => c.top.length);
  });
  (s.injuries || []).forEach(t => { out.injuries[t.team?.id] = (t.injuries || []).map(i => `${i.athlete?.displayName} (${i.status || i.type?.description || 'indispo'})`); });
  const groups = s.standings?.groups || [];
  groups.forEach(g => (g.standings?.entries || []).forEach(e => {
    const stat = (n) => e.stats?.find(x => x.name === n || x.abbreviation === n)?.displayValue;
    out.standings.push({ id: e.id || e.team?.id, team: e.team?.displayName || e.team, logo: e.team?.logos?.[0]?.href || e.logo?.[0]?.href, rank: stat('rank'), gp: stat('gamesPlayed'), w: stat('wins'), d: stat('ties'), l: stat('losses'), gd: stat('pointDifferential'), pts: stat('points') });
  }));
  if (!out.odds && s.pickcenter?.[0]) {
    const p = s.pickcenter[0];
    out.odds = { provider: p.provider?.name, overUnder: p.overUnder, home: americanToDecimal(p.homeTeamOdds?.moneyLine), away: americanToDecimal(p.awayTeamOdds?.moneyLine), draw: americanToDecimal(p.drawOdds?.moneyLine) };
  }
  return out;
}

const card = (title, icon, body) => `<section class="rounded-xl border border-line bg-panel">
  <div class="px-4 py-3 border-b border-line flex items-center gap-2 text-sm font-semibold"><i data-lucide="${icon}" class="w-4 h-4 text-accent"></i>${title}</div>
  <div class="p-4">${body}</div></section>`;

function renderDetail(m, s) {
  if (!m) return renderEmpty();
  const d = extractSummary(m, s);
  const loading = s === null;
  const sk = `<div class="space-y-2"><div class="skel h-4"></div><div class="skel h-4 w-5/6"></div><div class="skel h-4 w-2/3"></div></div>`;
  const live = m.state === 'in';

  // Team stat comparison
  const hs = d.teamStats[m.home.id] || [], as = d.teamStats[m.away.id] || [];
  const statRows = hs.map(x => {
    const y = as.find(z => z.label === x.label); const a = parseFloat(x.value) || 0, b = parseFloat(y?.value) || 0;
    const tot = Math.abs(a) + Math.abs(b) || 1;
    return `<div class="mb-3 last:mb-0"><div class="flex justify-between text-sm mb-1"><span class="font-semibold">${esc(x.value)}</span><span class="text-gray-400 text-xs">${esc(trLabel(x.label))}</span><span class="font-semibold">${esc(y?.value ?? '—')}</span></div>
      <div class="flex gap-1 h-1.5"><div class="flex-1 bg-line rounded-full overflow-hidden flex justify-end"><div class="bg-accent h-full" style="width:${Math.abs(a) / tot * 100}%"></div></div><div class="flex-1 bg-line rounded-full overflow-hidden"><div class="bg-sky-500 h-full" style="width:${Math.abs(b) / tot * 100}%"></div></div></div></div>`;
  }).join('');

  const lastFive = (t) => {
    const g = d.lastFive[t.id] || [];
    if (!g.length) return '<p class="text-sm text-gray-500">Aucune donnée.</p>';
    return g.slice().reverse().map(e => `<div class="flex items-center gap-2 py-1.5 text-sm border-b border-line last:border-0">
      <span class="form-${e.res} w-5 h-5 rounded grid place-items-center text-[10px] font-bold shrink-0">${e.res === 'W' ? 'V' : e.res === 'L' ? 'D' : 'N'}</span>
      <span class="text-gray-500 text-xs w-6">${e.atVs === '@' ? 'Ext' : 'Dom'}</span>
      ${e.oppLogo ? `<img src="${esc(e.oppLogo)}" class="w-4 h-4 object-contain">` : ''}
      <span class="flex-1 truncate">${esc(e.opp)}</span><span class="font-semibold tabular-nums">${esc(e.score)}</span></div>`).join('');
  };

  const odds = d.odds && (d.odds.home || d.odds.overUnder) ? `<div class="grid grid-cols-3 gap-2">
      ${[['1', m.home.short, d.odds.home], ['N', 'Nul', d.odds.draw], ['2', m.away.short, d.odds.away]].map(([k, l, v]) => `<div class="rounded-lg bg-base border border-line p-3 text-center"><div class="text-[11px] text-gray-500 truncate">${k} · ${esc(l)}</div><div class="text-lg font-semibold mt-0.5">${v || '—'}</div></div>`).join('')}
    </div>${d.odds.overUnder ? `<div class="mt-3 flex items-center justify-between text-sm"><span class="text-gray-400">Ligne buts (+/-)</span><span class="font-semibold">${d.odds.overUnder}${d.odds.over ? ` · Plus ${d.odds.over} / Moins ${d.odds.under}` : ''}</span></div>` : ''}
    ${d.odds.provider ? `<p class="text-[11px] text-gray-600 mt-2">Source : ${esc(d.odds.provider)}</p>` : ''}` : '<p class="text-sm text-gray-500">Cotes non disponibles.</p>';

  const h2h = d.h2h.length ? d.h2h.map(h => `<div class="flex items-center justify-between py-1.5 text-sm border-b border-line last:border-0">
      <span class="text-gray-500 text-xs w-24">${new Date(h.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
      <span class="flex-1 text-center truncate">${esc(h.home === m.home.id ? m.home.short : m.away.short)} <b class="mx-1 tabular-nums">${esc(h.hs)} - ${esc(h.as)}</b> ${esc(h.away === m.away.id ? m.away.short : m.home.short)}</span>
      <span class="text-gray-500 text-xs w-24 text-right truncate">${esc(h.comp || '')}</span></div>`).join('') : '<p class="text-sm text-gray-500">Aucune confrontation récente.</p>';

  const leaders = (t) => {
    const l = d.leaders[t.id] || [];
    if (!l.length) return t.leader ? `<p class="text-sm">${esc(t.leader)}</p>` : '<p class="text-sm text-gray-500">—</p>';
    return l.slice(0, 5).map(c => `<div class="flex justify-between gap-2 py-1 text-sm"><span class="text-gray-400 text-xs">${esc(trLabel(c.cat))}</span><span class="text-right truncate">${c.top.map(p => `${esc(p.name)} <b>${esc(p.val)}</b>`).join(', ')}</span></div>`).join('');
  };

  const standingRows = d.standings.length ? `<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-[11px] text-gray-500 uppercase"><tr><th class="text-left py-1.5 w-8">#</th><th class="text-left">Équipe</th><th>J</th><th>V</th><th>N</th><th>D</th><th>Diff</th><th>Pts</th></tr></thead><tbody>
    ${d.standings.slice(0, 24).map(r => { const hl = r.id === m.home.id || r.id === m.away.id || r.team === m.home.name || r.team === m.away.name;
      return `<tr class="border-t border-line ${hl ? 'bg-accent/10 text-white font-semibold' : 'text-gray-300'}"><td class="py-1.5">${esc(r.rank ?? '')}</td><td class="truncate max-w-[160px]">${esc(r.team)}</td><td class="text-center">${esc(r.gp ?? '')}</td><td class="text-center">${esc(r.w ?? '')}</td><td class="text-center">${esc(r.d ?? '')}</td><td class="text-center">${esc(r.l ?? '')}</td><td class="text-center">${esc(r.gd ?? '')}</td><td class="text-center">${esc(r.pts ?? '')}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<p class="text-sm text-gray-500">Classement non disponible.</p>';

  const inj = [m.home, m.away].map(t => `<div><div class="text-xs text-gray-400 mb-1">${esc(t.short)}</div><p class="text-sm">${(d.injuries[t.id] || []).length ? d.injuries[t.id].map(esc).join(', ') : '<span class="text-gray-500">Aucune absence signalée</span>'}</p></div>`).join('');

  $('#detail').innerHTML = `
  <div class="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
    <button id="backBtn" class="md:hidden flex items-center gap-1 text-sm text-gray-400 mb-1"><i data-lucide="chevron-left" class="w-4 h-4"></i>Matchs</button>
    <!-- Header -->
    <section class="rounded-xl border border-line bg-panel p-5">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400 mb-5">
        <span class="flex items-center gap-1.5 text-accent font-medium"><i data-lucide="trophy" class="w-3.5 h-3.5"></i>${esc(m.league)}</span>
        <span class="flex items-center gap-1.5"><i data-lucide="calendar" class="w-3.5 h-3.5"></i>${esc(fmtFull(m.date))}</span>
        <span class="flex items-center gap-1.5"><i data-lucide="map-pin" class="w-3.5 h-3.5"></i>${esc(m.venue)}${m.city ? ', ' + esc(m.city) : ''}</span>
        ${m.broadcasts.length ? `<span class="flex items-center gap-1.5"><i data-lucide="tv" class="w-3.5 h-3.5"></i>${esc(m.broadcasts.join(', '))}</span>` : ''}
      </div>
      <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        ${teamHead(m.home, 'Domicile')}
        <div class="text-center px-2">
          ${live ? `<div class="text-3xl font-bold tabular-nums">${esc(m.home.score)} - ${esc(m.away.score)}</div><div class="text-xs text-red-400 font-semibold mt-1">LIVE ${esc(m.clock)}</div>`
                 : `<div class="text-2xl sm:text-3xl font-bold">${fmtTime(m.date)}</div><div class="text-xs text-gray-400 mt-1">${countdown(m.date)}</div>`}
        </div>
        ${teamHead(m.away, 'Extérieur')}
      </div>
      <div class="mt-5 pt-4 border-t border-line flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <p class="text-sm text-gray-400 flex-1">Générez 3 scénarios probables basés sur la forme, les stats, les confrontations, le classement et les cotes.</p>
        <div id="analyzeArea"></div>
      </div>
    </section>

    <div id="analysis"></div>

    <div class="grid lg:grid-cols-2 gap-4">
      ${card('Cotes avant-match', 'percent', odds)}
      ${card(live ? 'Statistiques du match' : 'Statistiques de la saison', 'bar-chart-3', loading ? sk : (statRows || '<p class="text-sm text-gray-500">Statistiques non disponibles.</p>') + `<div class="flex justify-between text-[11px] text-gray-500 mt-3"><span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-accent"></span>${esc(m.home.short)}</span><span class="flex items-center gap-1">${esc(m.away.short)}<span class="w-2 h-2 rounded-full bg-sky-500"></span></span></div>`)}
      ${card(`5 derniers matchs · ${esc(m.home.short)}`, 'history', loading ? sk : lastFive(m.home))}
      ${card(`5 derniers matchs · ${esc(m.away.short)}`, 'history', loading ? sk : lastFive(m.away))}
      ${card('Confrontations directes', 'swords', loading ? sk : h2h)}
      ${card('Joueurs clés', 'user-round', loading ? sk : `<div class="grid grid-cols-1 gap-4">${[m.home, m.away].map(t => `<div><div class="text-xs font-semibold text-gray-300 mb-1 flex items-center gap-2">${logo(t, 'w-4 h-4')}${esc(t.short)}</div>${leaders(t)}</div>`).join('')}</div>`)}
      ${card('Absences & blessures', 'cross', loading ? sk : `<div class="space-y-3">${inj}</div>`)}
      ${card('Classement', 'list-ordered', loading ? sk : standingRows)}
    </div>
    <p class="text-[11px] text-gray-600 text-center pb-4">Données : ESPN. Les analyses IA sont indicatives et ne constituent pas un conseil de pari.</p>
  </div>`;
  $('#backBtn').onclick = () => { $('#detailPane').classList.add('hidden'); $('#listPane').classList.remove('hidden'); };
  renderAnalyzeBtn(m, loading);

  // Emplacement publicitaire visible, directement sous le bouton.
  const analyzeArea = document.getElementById('analyzeArea');
  if (analyzeArea) {
    analyzeArea.style.setProperty('display', 'flex', 'important');
    analyzeArea.style.setProperty('flex-direction', 'column', 'important');
    analyzeArea.style.setProperty('align-items', 'stretch', 'important');
    analyzeArea.style.setProperty('width', '100%', 'important');
    analyzeArea.style.setProperty('min-width', '0', 'important');
    analyzeArea.style.setProperty('gap', '8px', 'important');

    let detailAd = document.getElementById('detailAd');
    if (!detailAd) {
      detailAd = document.createElement('div');
      detailAd.id = 'detailAd';
      detailAd.innerHTML = `
        <ins class="adsbygoogle"
             style="display:block; min-height:90px; width:100%"
             data-ad-client="ca-pub-8143082489700562"
             data-ad-slot="1150108677"
             data-ad-format="auto"
             data-full-width-responsive="true"></ins>`;
    }

    detailAd.classList.remove('hidden');
    detailAd.style.setProperty('display', 'block', 'important');
    detailAd.style.setProperty('visibility', 'visible', 'important');
    detailAd.style.setProperty('width', '100%', 'important');
    detailAd.style.setProperty('min-height', '110px', 'important');
    detailAd.style.setProperty('padding', '8px 0', 'important');
    detailAd.setAttribute('aria-hidden', 'false');
    analyzeArea.appendChild(detailAd);

    let fallback = document.getElementById('detailAdFallback');
    if (!fallback) {
      fallback = document.createElement('div');
      fallback.id = 'detailAdFallback';
      fallback.style.cssText =
        'display:block;min-height:64px;padding:18px 8px;text-align:center;' +
        'border:1px dashed #64748b;border-radius:8px;color:#94a3b8;' +
        'font-size:12px;box-sizing:border-box;width:100%;';
      fallback.textContent =
        'EMPLACEMENT PUBLICITAIRE DE TEST — aucune annonce reçue';
      const slot = detailAd.querySelector('ins.adsbygoogle');
      if (slot) slot.insertAdjacentElement('afterend', fallback);
      else detailAd.appendChild(fallback);
    }

    const slot = detailAd.querySelector('ins.adsbygoogle');
    const updateFallback = () => {
      fallback.style.display =
        slot?.getAttribute('data-ad-status') === 'filled' ? 'none' : 'block';
    };
    updateFallback();
    if (slot && !slot.dataset.fallbackWatch) {
      slot.dataset.fallbackWatch = 'true';
      new MutationObserver(updateFallback).observe(slot, {
        attributes: true,
        attributeFilter: ['data-ad-status']
      });
    }

    if (slot && !detailAd.dataset.initialized &&
        !slot.hasAttribute('data-adsbygoogle-status')) {
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
        detailAd.dataset.initialized = 'true';
      } catch (e) {
        console.warn('AdSense : annonce non chargée', e);
      }
    }
  }

  renderAnalysis(m);

  renderAnalysis(m);
  icons_();
}

function teamHead(t, side) {
  return `<div class="flex flex-col items-center text-center min-w-0">
    ${logo(t, 'w-14 h-14 sm:w-16 sm:h-16')}
    <div class="font-semibold mt-2 text-sm sm:text-base leading-tight">${esc(t.name)}</div>
    <div class="text-[11px] text-gray-500 mt-0.5">${side}${t.record ? ' · ' + esc(t.record.replace(/-/g, '-')) + ' (V-N-D)' : ''}</div>
    <div class="mt-2">${formBadges(t.form)}</div></div>`;
}

function trLabel(l) {
  const map = { 'Goal Difference': 'Différence de buts', 'Total Goals': 'Buts marqués', 'Assists': 'Passes décisives', 'Goals Against': 'Buts encaissés',
    'Goals': 'Buts', 'Total Shots': 'Tirs', 'Accurate Passes': 'Passes réussies', 'Saves': 'Arrêts', 'Shots on Target': 'Tirs cadrés', 'Possession': 'Possession' };
  return map[l] || l;
}

/* ---------- AI analysis ---------- */
function renderAnalyzeBtn(m, loading) {
  const area = $('#analyzeArea'); if (!area) return;
  const busy = state.analyses[m.id] === 'loading';
  area.innerHTML = !ANALYZE_URL
    ? `<div class="h-10 px-4 rounded-lg border border-amber-500/40 bg-amber-500/5 text-amber-300 text-sm flex items-center gap-2"><i data-lucide="key-round" class="w-4 h-4"></i>Clé API d'analyse à configurer</div>`
    : `<button id="analyzeBtn" ${busy || loading ? 'disabled' : ''} class="h-10 px-5 rounded-lg bg-accent text-[#052e1f] font-semibold text-sm flex items-center justify-center gap-2 hover:bg-emerald-400 disabled:opacity-60 w-full sm:w-auto">
        <i data-lucide="${busy ? 'loader-2' : 'sparkles'}" class="w-4 h-4 ${busy ? 'spin' : ''}"></i>${busy ? 'Analyse en cours…' : state.analyses[m.id] && state.analyses[m.id] !== 'loading' ? 'Relancer l\'analyse' : 'Analyser avec l\'IA'}</button>`;
  $('#analyzeBtn') && ($('#analyzeBtn').onclick = () => { if (!authenticated) openAuth(m); else analyze(m); });
  icons_();
}

function buildContext(m) {
  const d = extractSummary(m, state.summaries[m.id]);
  const team = (t) => ({
    nom: t.name, forme_5_derniers: t.form, bilan_V_N_D: t.record,
    stats_saison: d.teamStats[t.id], derniers_matchs: (d.lastFive[t.id] || []).map(e => `${e.res} ${e.atVs === '@' ? 'ext' : 'dom'} vs ${e.opp} ${e.score} (${e.comp})`),
    joueurs_cles: (d.leaders[t.id] || []).map(c => `${c.cat}: ${c.top.map(p => p.name + ' ' + p.val).join(', ')}`),
    absences: d.injuries[t.id] || [],
    classement: d.standings.find(r => r.id === t.id || r.team === t.name) || null
  });
  return {
    match: `${m.home.name} (domicile) vs ${m.away.name} (extérieur)`, championnat: m.league, date: fmtFull(m.date), stade: `${m.venue} ${m.city}`,
    domicile: team(m.home), exterieur: team(m.away),
    confrontations_directes: d.h2h.map(h => `${h.date?.slice(0, 10)}: ${h.home === m.home.id ? m.home.name : m.away.name} ${h.hs}-${h.as} ${h.away === m.away.id ? m.away.name : m.home.name}`),
    cotes_decimales: d.odds
  };
}

async function analyze(m) {
  state.analyses[m.id] = 'loading';
  renderAnalyzeBtn(m);
  renderAnalysis(m);

  const startedAt = Date.now();
  const ctx = buildContext(m);
  let auditId = null;
  let auditFinished = false;

  const finishAudit = async status => {
    if (!auditId || auditFinished) return;

    const finishUrl = ANALYZE_URL.replace(/\/$/, '') +
      '/api/analysis/audit/' + encodeURIComponent(String(auditId)) + '/finish';

    // Deux tentatives au maximum en cas d'échec réseau ou HTTP.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const finishResponse = await fetch(finishUrl, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });

        if (finishResponse.ok) {
          auditFinished = true;
          return;
        }
      } catch (_) {
        // Ne pas masquer le résultat de l'analyse.
      }

      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.warn('Clôture du journal d’analyse non confirmée.', {
      auditId,
      status
    });
  };

  try {
    const response = await fetch(
      ANALYZE_URL.replace(/\/$/, '') + '/analyze',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: String(m.id), context: ctx })
      }
    );

    let raw = await response.json();
    auditId = raw.auditId || null;

    // Afficher le chargement pendant au moins cinq secondes.
    const elapsed = Date.now() - startedAt;
    if (elapsed < 5000) {
      await new Promise(resolve => setTimeout(resolve, 5000 - elapsed));
    }

    if (response.status === 202 && raw.pending) {
      let readyResult = null;

      // Consultation du cache sans répéter la demande payante.
      for (let attempt = 0; attempt < 36; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5000));

        const check = await fetch(
          ANALYZE_URL.replace(/\/$/, '') +
            '/api/analysis/' + encodeURIComponent(String(m.id))
        );
        const status = await check.json();

        if (!check.ok) {
          throw new Error(status.error || 'Impossible de consulter le cache.');
        }

        if (status.error) {
          throw new Error(status.error);
        }

        if (status.ready && status.result) {
          readyResult = status.result;
          readyResult.generatedAt = status.generatedAt
            ? new Date(status.generatedAt).getTime()
            : Date.now();
          break;
        }
      }

      if (!readyResult) {
        throw new Error(
          "L'analyse n'est pas encore prête. Réessaie dans quelques minutes."
        );
      }

      raw = readyResult;
      await finishAudit('success');
    } else if (!response.ok || raw.error) {
      throw new Error(raw.error || "Erreur du service d'analyse.");
    } else {
      raw.generatedAt = Date.now();
    }

    state.analyses[m.id] = raw;
  } catch (error) {
    await finishAudit('error');
    state.analyses[m.id] = {
      error: error?.message || "Erreur lors de la récupération de l'analyse."
    };
  }

  if (state.selected === m.id) {
    renderAnalyzeBtn(m);
    renderAnalysis(m);
  }
}

async function _unusedLegacy(m, ctx) {
  const prompt = `Tu es un analyste football expert. À partir des données d'avant-match ci-dessous (JSON), propose exactement 3 scénarios plausibles et distincts pour ce match. Base-toi uniquement sur les données fournies et sur ta connaissance générale des équipes. Les probabilités des 3 scénarios doivent totaliser 100.

DONNÉES:
${JSON.stringify(ctx)}

Réponds UNIQUEMENT avec un JSON valide (sans markdown) au format :
{
 "resume": "synthèse en 2-3 phrases du rapport de force",
 "scenarios": [
   {"titre": "titre court", "issue": "1|N|2", "probabilite": 45, "score_probable": "2-1", "total_buts": "Plus de 2.5", "deux_equipes_marquent": "Oui|Non", "deroulement": "récit du déroulé du match en 3-4 phrases", "facteurs_cles": ["facteur 1","facteur 2","facteur 3"]}
 ],
 "points_attention": ["point 1","point 2"],
 "confiance": "Faible|Moyenne|Élevée"
}`;
  return prompt;
}

function renderAnalysis(m) {
  const box = $('#analysis');
  if (!box) return;

  const a = state.analyses[m.id];

  if (!a) {
    box.innerHTML = '';
    return;
  }

  if (a === 'loading') {
    box.innerHTML = `
    <section class="rounded-xl border border-accent/40 bg-panel p-5">
      <div class="flex items-center gap-2 text-sm font-semibold">
        <i data-lucide="loader-2" class="w-4 h-4 text-accent spin"></i>
        Analyse IA en cours...
      </div>
    </section>`;
    return icons_();
  }

  if (a.error) {
    const quotaReached = false; // Quota et récompenses désactivés.

    if (quotaReached) {
      const overlayId = 'zouzouaRewardAdOverlay';
      document.getElementById(overlayId)?.remove();

      const overlay = document.createElement('div');
      overlay.id = overlayId;
      overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/95 p-4';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'zouzouaRewardAdTitle');

      overlay.innerHTML = `
        <section class="w-full max-w-md rounded-2xl border border-line bg-panel p-5 text-center text-white shadow-2xl">
          <h2 id="zouzouaRewardAdTitle" class="sr-only">Publicité</h2>

          <div class="flex min-h-[120px] items-center justify-center overflow-hidden rounded-lg bg-black/20 p-2">
            <ins class="adsbygoogle"
                 style="display:block; min-width:250px; min-height:100px"
                 data-ad-client="ca-pub-8143082489700562"
                 data-ad-slot="1733558459"
                 data-ad-format="auto"
                 data-full-width-responsive="true"></ins>
          </div>

          <p id="zouzouaRewardStatus" class="mt-3 text-xs text-gray-400">Patiente 20 secondes pour une nouvelle analyse.</p>
          <button id="zouzouaCloseRewardAd" type="button" disabled
                  class="mt-4 w-full rounded-lg border border-line px-4 py-3 font-semibold opacity-50 cursor-not-allowed">
            Masquer (20)
          </button>
        </section>`;

      document.body.appendChild(overlay);

      const rewardAd = overlay.querySelector('.adsbygoogle');
      if (rewardAd && !rewardAd.dataset.adsbygoogleStatus) {
        try {
          (window.adsbygoogle = window.adsbygoogle || []).push({});
        } catch (error) {
          console.warn('Annonce AdSense indisponible :', error.message);
        }
      }

      const closeButton = overlay.querySelector('#zouzouaCloseRewardAd');
      const countdown = overlay.querySelector('#zouzouaRewardCountdown');
      const status = overlay.querySelector('#zouzouaRewardStatus');

      closeButton.disabled = true;
      closeButton.classList.add('opacity-50', 'cursor-not-allowed');

      (async () => {
        try {
          // Créer une session de récompense pour l'utilisateur connecté.
          const startResponse = await fetch('/api/reward-simulation/start', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });

          const startData = await startResponse.json().catch(() => ({}));

          if (!startResponse.ok || !startData.ok) {
            status.textContent = startData.error || 'Impossible de démarrer la récompense.';
            return;
          }

          // Les administrateurs ont déjà leurs tickets illimités.
          if (startData.alreadyRewarded) {
            status.textContent = 'Les administrateurs disposent déjà de tickets illimités.';
            return;
          }

          const sessionId = startData.sessionId;
          if (!sessionId) {
            status.textContent = 'Aucune session de récompense reçue du serveur.';
            return;
          }

          for (let seconds = 20; seconds > 0; seconds--) {
            status.textContent = `Patiente ${seconds} seconde${seconds > 1 ? 's' : ''} pour le crédit de test.`;
            closeButton.textContent = `Masquer (${seconds})`;
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (!document.body.contains(overlay)) return;
          }

          if (countdown) countdown.textContent = '';
          status.textContent = 'Ajout du crédit de test…';

          const claimController = new AbortController();
          const claimTimeout = setTimeout(() => claimController.abort(), 30000);

          let response;
          try {
            response = await fetch('/api/reward-simulation/claim', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId }),
              signal: claimController.signal
            });
          } finally {
            clearTimeout(claimTimeout);
          }
          const data = await response.json().catch(() => ({}));

          if (!response.ok || !data.ok) {
            status.textContent = data.error || 'Le crédit de test n’a pas pu être ajouté.';
          } else {
            status.textContent = `Crédit de test ajouté. Solde : ${data.credits} crédit(s).`;
          }
        } catch (error) {
          console.error('Erreur de crédit de test :', error);
          status.textContent = 'Connexion indisponible. Réessaie plus tard.';
        } finally {
          closeButton.disabled = false;
          closeButton.textContent = 'Masquer ✕';
          closeButton.classList.remove('opacity-50', 'cursor-not-allowed');
          closeButton.classList.add('hover:bg-white/10');
        }
      })();

      closeButton.addEventListener('click', () => {
        if (closeButton.disabled) return;
        overlay.remove();
        box.innerHTML = `
          <section class="rounded-xl border border-line bg-panel p-4 text-gray-300">
            <p>Tu peux maintenant lancer une nouvelle analyse.</p>
          </section>`;
        icons_();
      });

      return icons_();
    }

    box.innerHTML = `
    <section class="rounded-xl border border-red-500/40 bg-red-500/5 p-4 text-red-300">
      <p>${esc(a.error)}</p>
    </section>`;
    return icons_();
  }


  const pronos = a.pronostics || [];

  console.log("===== PRONOS RENDER =====");
  console.log(a.pronostics);
  console.log("Nombre :", a.pronostics?.length);


  box.innerHTML = `
  <section class="rounded-xl border border-line bg-panel">

    <div class="px-4 py-3 border-b border-line flex items-center gap-2">
      <i data-lucide="sparkles" class="w-4 h-4 text-accent"></i>
      <span class="font-semibold text-sm">
        Pronostics IA
      </span>
    </div>


    <div class="p-4 space-y-4">


      ${a.resume ? `
      <p class="text-sm text-gray-300 leading-relaxed">
      ${esc(a.resume)}
      </p>` : ''}



      <div class="grid md:grid-cols-3 gap-3">

      ${pronos.map((p,i)=>`

      <article class="relative rounded-lg border ${i === 0 ? 'border-accent/50 bg-accent/5' : 'border-line'} bg-base p-4">

        <div class="flex justify-between items-center mb-3">

          <span class="text-xs font-bold uppercase text-accent">
          ${i === 0 ? '⭐ Meilleur choix IA' : 'Pronostic ' + (i + 1)}
          </span>

          <span class="text-lg font-bold">
          ${esc(p.probabilite)}
          </span>

        </div>


        <h3 class="font-semibold mb-2">
        ${esc(p.marche)}
        </h3>


        <div class="px-2 py-1 rounded bg-panel border border-line text-sm mb-3">
        Choix : <b>${esc(p.choix)}</b>
        </div>


        <div class="text-xs mb-3">
        Confiance :
        <span class="font-semibold">
        ${esc(p.confiance)}
        </span>
        </div>


        <p class="text-sm text-gray-400 leading-relaxed">
        ${esc(p.explication)}
        </p>


      </article>

      `).join('')}

      </div>



      ${a.bilan_final ? `
      <div class="rounded-lg border border-line bg-base p-4 text-sm text-gray-300">
      <b>Bilan :</b><br>
      ${esc(a.bilan_final)}
      </div>`:''}



      ${a.generatedAt ? `
      <p class="text-[11px] text-gray-600">
      Généré le ${new Date(a.generatedAt).toLocaleString('fr-FR')}
      ${a.model ? ' · Modèle : '+esc(a.model):''}
      </p>`:''}


    </div>

  </section>`;


  icons_();
}


/* ---------- Authentification locale ---------- */
let authenticated = false;
let currentUserRole = null;
let authMode = 'login';
let pendingMatch = null;

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

function openAuth(match) {
  pendingMatch = match || null;
  setAuthMode('login');
  $('#authScreen').style.display = 'flex';
  $('#authPhone').focus();
}

function renderAuthBox() {
  const box = $('#authBox');
  if (!box) return;

  if (authenticated) {
    box.innerHTML =
      (currentUserRole === 'admin'
        ? '<button id="adminPanelBtn" class="h-9 px-3 rounded-lg border border-accent text-accent hover:bg-panel text-sm">Panel admin</button>'
        : '') +
      '<button id="signOut" class="h-9 px-3 rounded-lg border border-border hover:bg-panel text-sm">Déconnexion</button>';

    const adminButton = $('#adminPanelBtn');
    if (adminButton) {
      adminButton.onclick = () => { location.href = '/admin.html'; };
    }

    $('#signOut').onclick = async () => {
      try {
        await fetch('/api/logout', {
          method: 'POST',
          credentials: 'same-origin'
        });
      } finally {
        authenticated = false;
        currentUserRole = null;
        state.analyses = {};
        renderAuthBox();
      }
    };
  } else {
    currentUserRole = null;
    box.innerHTML = '<button id="signIn" class="h-9 px-3 rounded-lg border border-border hover:bg-panel text-sm">Connexion</button>';
    $('#signIn').onclick = () => openAuth(null);
  }

  icons_();
}

function enterApp(user) {
  authenticated = true;
  currentUserRole = user?.role || 'user';
  $('#authScreen').style.display = 'none';
  renderAuthBox();

  const match = pendingMatch;
  pendingMatch = null;
  if (match) analyze(match);
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
          phone: '+225' + $('#authPhone').value.replace(/\D/g, ''),
          password: $('#authPassword').value
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Authentification impossible.');
      $('#authPassword').value = '';
      const meResponse = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
      if (!meResponse.ok) throw new Error("Connexion établie, mais vérification du compte impossible.");
      const me = await meResponse.json();
      enterApp(me);
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
      const me = await response.json();
      authenticated = me.authenticated === true;
      currentUserRole = authenticated ? me.role : null;
    }
  } catch (error) {
    console.error('Vérification de session impossible :', error);
  }

  $('#authScreen').style.display = 'none';
  renderAuthBox();
}

/* ---------- Init ---------- */
$('#search').oninput = (e) => { state.filter = e.target.value; renderList(); };
$('#leagueFilter').onchange = (e) => { state.league = e.target.value; renderList(); };
$('#refreshBtn').onclick = loadMatches;
icons_();
initAuth();
loadMatches();
setInterval(loadMatches, 10 * 60 * 1000);
