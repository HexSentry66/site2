const $ = s => document.querySelector(s);
const content = $('#content'), denied = $('#denied'), message = $('#message');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = v => v ? esc(new Date(v).toLocaleString('fr-FR')) : 'Jamais';
async function api(url, options={}) {
  const r = await fetch(url, {credentials:'same-origin', cache:'no-store', ...options,
    headers:{'Content-Type':'application/json', ...(options.headers||{})}});
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || 'Erreur de requête');
  return data;
}
function tableRows(id, rows, empty, render) {
  $(id).innerHTML = rows.length ? rows.map(render).join('') :
    '<tr><td colspan="9" class="muted">'+esc(empty)+'</td></tr>';
}
async function load() {
  message.textContent = 'Chargement…';
  try {
    const me = await api('/api/me');
    if (me.role !== 'admin') {
      content.hidden = true; denied.hidden = false;
      message.textContent = 'Ton compte ne possède pas les droits administrateur.';
      return;
    }
    const [stats, userData, analysisData, loginData] = await Promise.all([
      api('/api/admin/stats'), api('/api/admin/users'),
      api('/api/admin/analyses'), api('/api/admin/logins')
    ]);
    const cards = [
      ['Comptes',stats.users.total],['Administrateurs',stats.users.admins],
      ['Utilisateurs',stats.users.regular],['Actifs sur 7 jours',stats.activeUsers7Days],
      ['Analyses totales',stats.analyses.total],['Analyses aujourd’hui',stats.analyses.today],
      ['Analyses réussies',stats.analyses.successful],['Analyses en erreur',stats.analyses.failed]
    ];
    $('#stats').innerHTML = cards.map(([label,n])=>'<div class="card"><div class="muted">'+esc(label)+'</div><div class="number">'+esc(n)+'</div></div>').join('');
    tableRows('#users', userData.users, 'Aucun compte', u => {
      const isSuper = Number(me.id) === 1;
      const isSelf = Number(u.id) === 1;
      const suspended = Number(u.suspended) === 1;
      let actions = 'Lecture seule';

      if (isSuper && !isSelf) {
        const role = u.role === 'admin' ? 'user' : 'admin';
        actions =
          '<button data-id="' + esc(u.id) + '" data-action="role" data-role="' + role + '">' +
          (role === 'admin' ? 'Promouvoir admin' : 'Retirer admin') + '</button> ' +
          '<button data-id="' + esc(u.id) + '" data-action="status" data-suspended="' +
          (suspended ? 'false' : 'true') + '">' +
          (suspended ? 'Réactiver' : 'Suspendre') + '</button> ' +
          '<button data-id="' + esc(u.id) + '" data-action="delete">Supprimer</button>';
      } else if (isSelf) {
        actions = 'Compte super administrateur protégé';
      }

      return '<tr><td>' + esc(u.id) +
        '</td><td>' + esc(u.phone) +
        '</td><td><span class="status">' + esc(u.role) +
        '</span></td><td>' + date(u.created_at) +
        '</td><td>' + date(u.last_login_at) +
        '</td><td>' + esc(u.login_count) +
        '</td><td>' + esc(u.analysis_count) +
        '</td><td>' + esc(u.free_used) + ' gratuites / ' + esc(u.rewarded_used) + ' récompensées' +
        '</td><td>' + (suspended ? 'Suspendu' : 'Actif') +
        '</td><td>' + actions + '</td></tr>';
    });
    tableRows('#analyses',analysisData.events,'Aucune analyse enregistrée',e=>'<tr><td>'+date(e.started_at)+'</td><td>'+esc(e.phone)+' (#'+esc(e.user_id)+')</td><td>'+esc(e.match_text||'Non précisé')+'</td><td>'+esc(e.competition||'—')+'</td><td>'+esc(e.match_date||'—')+'</td><td class="'+(e.status==='success'?'success':e.status==='error'?'error':'')+'">'+esc(e.status)+'</td></tr>');
    tableRows('#logins',loginData.events,'Aucune connexion enregistrée',e=>'<tr><td>'+date(e.logged_in_at)+'</td><td>'+esc(e.phone)+' (#'+esc(e.user_id)+')</td><td>'+esc(e.role)+'</td></tr>');
    content.hidden = false; denied.hidden = true; message.textContent = '';
  } catch(e) {
    content.hidden = true; message.textContent = e.message;
    if (/Accès réservé|Connexion requise|Session expirée/i.test(e.message)) denied.hidden = false;
  }
}
$('#users').addEventListener('click', async e => {
  const b = e.target.closest('button[data-id][data-action]');
  if (!b) return;

  const id = encodeURIComponent(b.dataset.id);
  const action = b.dataset.action;
  let url, options, question;

  if (action === 'role') {
    const role = b.dataset.role;
    question = (role === 'admin' ? 'Promouvoir cet utilisateur en administrateur ?'
      : 'Retirer les droits administrateur à cet utilisateur ?');
    url = '/api/admin/users/' + id + '/role';
    options = { method: 'PATCH', body: JSON.stringify({ role }) };
  } else if (action === 'status') {
    const suspended = b.dataset.suspended === 'true';
    question = suspended
      ? 'Suspendre ce compte ? Sa session sera refusée dès sa prochaine requête.'
      : 'Réactiver ce compte ?';
    url = '/api/admin/users/' + id + '/status';
    options = { method: 'PATCH', body: JSON.stringify({ suspended }) };
  } else if (action === 'delete') {
    if (!confirm('ATTENTION : supprimer définitivement ce compte et ses historiques associés ?')) return;
    const confirmation = prompt('Pour confirmer la suppression, tape SUPPRIMER :');
    if (confirmation !== 'SUPPRIMER') {
      alert('Suppression annulée.');
      return;
    }
    url = '/api/admin/users/' + id;
    options = { method: 'DELETE' };
    question = null;
  } else {
    return;
  }

  if (question && !confirm(question)) return;
  b.disabled = true;

  try {
    await api(url, options);
    await load();
  } catch (err) {
    alert(err.message);
    b.disabled = false;
  }
});
$('#reload').addEventListener('click',load);
$('#logout').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST'});}finally{location.href='/';}});
load();
