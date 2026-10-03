/* Interface de validation de la revue de portée — version 1 (onglet « Doublons à confirmer »).
   HTML/CSS/JS sans étape de construction. Les données sont déchiffrées en mémoire (crypto.js). */
(function () {
  'use strict';

  var CONFIG = {
    repo: 'FlaviusMedIng/TBI_scoping_review',
    decisionsDir: 'data/screening/ui_decisions',
    contactEmail: 'flavius.timis@etu.unige.ch',
    dataUrl: 'data/dedup.enc.json',
    manifestUrl: 'data/manifest.json'
  };
  var DECISIONS = [
    { value: 'fusionner tout', label: 'Fusionner tout' },
    { value: 'garder séparés', label: 'Garder séparés' },
    { value: 'lier', label: 'Lier (même étude, rapports différents)' },
    { value: 'fusionner sauf', label: 'Fusionner sauf…' }
  ];
  var KEYS = {
    reviewer: 'tbi-webui.reviewer',
    token: 'tbi-webui.github-token',
    pass: 'tbi-webui.passphrase',               // sessionStorage seulement
    drafts: function (r) { return 'tbi-webui.dedup.drafts.' + r; },
    synced: function (r) { return 'tbi-webui.dedup.synced.' + r; },
    deleted: function (r) { return 'tbi-webui.dedup.deleted.' + r; }
  };
  var REVIEWER_RE = /^[a-z0-9_-]{1,40}$/;

  var state = {
    groups: [], byId: new Map(), builtAt: '',
    filter: 'todo', search: '', currentId: null,
    reviewer: '', token: '',
    drafts: {}, synced: {}, deleted: {},
    live: new Map()
  };

  /* ---------- utilitaires ---------- */
  function $(id) { return document.getElementById(id); }
  function store(kind) { try { return window[kind]; } catch (e) { return null; } }
  function sget(kind, k) { try { var s = store(kind); return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function sset(kind, k, v) { try { var s = store(kind); if (s) s.setItem(k, v); } catch (e) { /* stockage indisponible */ } }
  function sdel(kind, k) { try { var s = store(kind); if (s) s.removeItem(k); } catch (e) { /* idem */ } }
  function jget(k, dflt) { try { return JSON.parse(sget('localStorage', k)) || dflt; } catch (e) { return dflt; } }
  function jset(k, v) { sset('localStorage', k, JSON.stringify(v)); }

  /* Petit constructeur DOM : jamais d'innerHTML avec des données (notices ou réponses d'API). */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (a) {
        var v = attrs[a];
        if (v === null || v === undefined || v === false) return;
        if (a === 'class') el.className = v;
        else if (a === 'text') el.textContent = v;
        else if (a.slice(0, 2) === 'on') el.addEventListener(a.slice(2), v);
        else if (v === true) el.setAttribute(a, '');
        else el.setAttribute(a, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function link(href, text, title) {
    return h('a', { href: href, target: '_blank', rel: 'noopener noreferrer', title: title || null }, text);
  }
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function doiPath(doi) { return doi.split('/').map(encodeURIComponent).join('/'); }
  function nowIso() { return new Date().toISOString(); }
  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString('fr-CH', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; }
  }
  function setMsg(el, text, kind) { el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); }

  /* ---------- déverrouillage ---------- */
  function showManifest() {
    fetch(CONFIG.manifestUrl, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
      if (!m) return;
      var d = m.files && m.files['dedup.enc.json'];
      $('manifest-info').textContent = 'Données construites le ' + fmtDate(m.builtAt) +
        (d ? ' — ' + d.groups + ' groupes de doublons, dont ' + d.groupsToDecide + ' à décider.' : '');
    }).catch(function () { /* manifeste facultatif */ });
  }

  async function unlock(pass, quiet) {
    var msg = $('unlock-msg');
    setMsg(msg, 'Déchiffrement…');
    try {
      var r = await fetch(CONFIG.dataUrl, { cache: 'no-store' });
      if (!r.ok) throw new Error('fichier de données introuvable (' + r.status + ')');
      var env = await r.json();
      var data;
      try { data = await window.TBICrypto.decryptEnvelope(env, pass); }
      catch (e) { throw new Error('phrase de passe incorrecte'); }
      state.builtAt = data.builtAt;
      state.groups = (data.dedup && data.dedup.groups) || [];
      state.byId = new Map(state.groups.map(function (g) { return [g.id, g]; }));
      if ($('remember-session').checked || quiet) sset('sessionStorage', KEYS.pass, pass);
      $('passphrase').value = '';
      setMsg(msg, '');
      startApp();
    } catch (e) {
      if (quiet) { sdel('sessionStorage', KEYS.pass); setMsg(msg, ''); return; }
      setMsg(msg, 'Échec : ' + e.message + '.', 'error');
    }
  }

  function lock() {
    sdel('sessionStorage', KEYS.pass);
    location.hash = '';
    location.reload();
  }

  /* ---------- relecteur et brouillons ---------- */
  function loadReviewer() {
    state.reviewer = sget('localStorage', KEYS.reviewer) || '';
    state.token = sget('localStorage', KEYS.token) || '';
    loadDrafts();
  }
  function loadDrafts() {
    var r = state.reviewer;
    state.drafts = r ? jget(KEYS.drafts(r), {}) : {};
    state.synced = r ? jget(KEYS.synced(r), {}) : {};
    state.deleted = r ? jget(KEYS.deleted(r), {}) : {};
  }
  function saveDrafts() {
    if (!state.reviewer) return;
    jset(KEYS.drafts(state.reviewer), state.drafts);
    jset(KEYS.synced(state.reviewer), state.synced);
    jset(KEYS.deleted(state.reviewer), state.deleted);
  }
  function unsyncedCount() {
    var n = Object.keys(state.drafts).filter(function (id) { return state.synced[id] !== state.drafts[id].timestamp; }).length;
    return n + Object.keys(state.deleted).length;
  }
  function updateWho() {
    $('who-label').textContent = 'Relecteur : ' + (state.reviewer || '— (à définir dans Réglages)');
    var n = unsyncedCount(), s = $('sync-status');
    if (!state.reviewer) { s.textContent = ''; return; }
    if (!state.token) { s.textContent = n ? n + ' décision(s) locale(s), pas de jeton' : 'sans jeton GitHub'; s.className = 'badge warn'; }
    else if (n) { s.textContent = n + ' non envoyée(s)'; s.className = 'badge warn'; }
    else { s.textContent = 'tout est envoyé'; s.className = 'badge ok'; }
    $('push-all').disabled = !state.token;
  }

  /* ---------- GitHub (API REST « contents ») ---------- */
  function ghPath() { return CONFIG.decisionsDir + '/dedup_' + state.reviewer + '.json'; }
  function ghFetch(path, opts) {
    opts = opts || {};
    var headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + state.token,
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch('https://api.github.com/repos/' + CONFIG.repo + '/contents/' + path,
      { method: opts.method || 'GET', headers: headers, body: opts.body, cache: 'no-store' });
  }
  function utf8ToB64(s) {
    var bytes = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64ToUtf8(s) { return new TextDecoder().decode(window.TBICrypto.b64ToBytes(s.replace(/\s/g, ''))); }

  async function ghRead() {
    var r = await ghFetch(ghPath());
    if (r.status === 404) return { sha: null, data: {} };
    if (r.status === 401 || r.status === 403) throw new Error('jeton refusé (' + r.status + ')');
    if (!r.ok) throw new Error('lecture GitHub impossible (' + r.status + ')');
    var j = await r.json();
    var data = {};
    try { data = JSON.parse(b64ToUtf8(j.content || '')) || {}; } catch (e) { throw new Error('fichier distant illisible'); }
    return { sha: j.sha, data: data };
  }

  /* Reprend localement les entrées distantes plus récentes (autre appareil du même relecteur). */
  function pullInto(remote) {
    Object.keys(remote).forEach(function (id) {
      var e = remote[id], mine = state.drafts[id], del = state.deleted[id];
      if (!e || !e.timestamp) return;
      if (del && del >= e.timestamp) return;
      if (!mine || mine.timestamp < e.timestamp) { state.drafts[id] = e; state.synced[id] = e.timestamp; }
      else if (mine.timestamp === e.timestamp) state.synced[id] = e.timestamp;
    });
  }

  async function pull(silent) {
    if (!state.token || !state.reviewer) return;
    try {
      var res = await ghRead();
      pullInto(res.data);
      saveDrafts();
      refresh();
    } catch (e) { if (!silent) alert('GitHub : ' + e.message); else console.warn(e); }
  }

  async function push() {
    if (!state.reviewer) { openSettings(); return false; }
    if (!state.token) { alert('Aucun jeton GitHub : utilisez « Télécharger mes décisions (JSON) » ou ajoutez un jeton dans Réglages.'); return false; }
    var s = $('sync-status');
    s.textContent = 'envoi…'; s.className = 'badge info';
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        var res = await ghRead();
        pullInto(res.data);
        var merged = Object.assign({}, res.data);
        Object.keys(state.deleted).forEach(function (id) {
          if (merged[id] && merged[id].timestamp <= state.deleted[id]) delete merged[id];
        });
        Object.keys(state.drafts).forEach(function (id) {
          var mine = state.drafts[id];
          if (!merged[id] || !merged[id].timestamp || merged[id].timestamp <= mine.timestamp) merged[id] = mine;
        });
        var sorted = {};
        Object.keys(merged).sort().forEach(function (id) { sorted[id] = merged[id]; });
        var body = {
          message: 'webui : décisions doublons de ' + state.reviewer + ' (' + Object.keys(sorted).length + ' groupes)',
          content: utf8ToB64(JSON.stringify(sorted, null, 2) + '\n')
        };
        if (res.sha) body.sha = res.sha;
        var r = await ghFetch(ghPath(), { method: 'PUT', body: JSON.stringify(body) });
        if (r.status === 409 || r.status === 422) continue;          // fichier modifié entre-temps : on relit
        if (r.status === 401 || r.status === 403) throw new Error('écriture refusée (' + r.status + ') — vérifiez la permission Contents : lecture et écriture');
        if (!r.ok) throw new Error('écriture impossible (' + r.status + ')');
        Object.keys(sorted).forEach(function (id) { if (state.drafts[id]) state.synced[id] = state.drafts[id].timestamp; });
        state.deleted = {};
        saveDrafts();
        refresh();
        return true;
      } catch (e) {
        updateWho();
        alert('Envoi GitHub : ' + e.message + '. Vos décisions restent enregistrées dans ce navigateur.');
        return false;
      }
    }
    updateWho();
    alert('Envoi GitHub : conflit de version répété, réessayez.');
    return false;
  }

  function download() {
    if (!state.reviewer) { openSettings(); return; }
    var sorted = {};
    Object.keys(state.drafts).sort().forEach(function (id) { sorted[id] = state.drafts[id]; });
    var blob = new Blob([JSON.stringify(sorted, null, 2) + '\n'], { type: 'application/json' });
    var a = h('a', { href: URL.createObjectURL(blob), download: 'dedup_' + state.reviewer + '.json' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------- réglages ---------- */
  function openSettings() {
    $('reviewer').value = state.reviewer;
    $('token').value = '';
    $('token').placeholder = state.token ? 'jeton enregistré (laisser vide pour le garder)' : 'github_pat_… (facultatif)';
    setMsg($('settings-msg'), '');
    $('settings').showModal();
  }
  function saveSettings(ev) {
    ev.preventDefault();
    var rv = $('reviewer').value.trim().toLowerCase();
    if (!REVIEWER_RE.test(rv)) { setMsg($('settings-msg'), 'Nom invalide : minuscules, chiffres, - ou _ (40 caractères au plus).', 'error'); return; }
    var tok = $('token').value.trim();
    if (tok) { sset('localStorage', KEYS.token, tok); state.token = tok; }
    $('token').value = '';
    if (rv !== state.reviewer) { sset('localStorage', KEYS.reviewer, rv); state.reviewer = rv; loadDrafts(); }
    $('settings').close();
    refresh();
    pull(true);
  }
  function clearToken() {
    sdel('localStorage', KEYS.token);
    state.token = '';
    $('token').value = '';
    $('token').placeholder = 'github_pat_… (facultatif)';
    setMsg($('settings-msg'), 'Jeton effacé de ce navigateur. Pensez à le révoquer sur GitHub s\'il a pu être exposé.', 'ok');
    updateWho();
  }
  async function testToken() {
    var prev = state.token, tok = $('token').value.trim() || state.token, m = $('settings-msg');
    if (!tok) { setMsg(m, 'Aucun jeton à tester.', 'error'); return; }
    setMsg(m, 'Test…');
    state.token = tok;
    try {
      var r = await ghFetch(CONFIG.decisionsDir);
      if (r.ok || r.status === 404) setMsg(m, 'Lecture du dépôt autorisée' + (r.status === 404 ? ' (dossier des décisions encore absent : il sera créé au premier envoi)' : '') + '. L\'écriture sera vérifiée au premier envoi.', 'ok');
      else setMsg(m, 'Accès refusé (' + r.status + ') : vérifiez le dépôt choisi et la permission Contents.', 'error');
    } catch (e) { setMsg(m, 'Erreur réseau : ' + e.message, 'error'); }
    state.token = prev;
  }

  /* ---------- statut d'un groupe ---------- */
  function draftOf(g) { return state.drafts[g.id] || null; }
  function isDecided(g) { return !!(g.decision || draftOf(g)); }
  function draftText(d) {
    if (!d) return '';
    return d.decision === 'fusionner sauf' ? 'fusionner sauf ' + d.keep_out.join(', ') : d.decision;
  }
  function badgesFor(g) {
    var out = [], d = draftOf(g);
    if (g.decision) out.push(h('span', { class: 'badge ok', text: 'CSV : ' + g.decision }));
    if (d) {
      var conflict = g.decision && g.decision !== draftText(d);
      out.push(h('span', { class: 'badge ' + (conflict ? 'bad' : 'info'), text: (conflict ? 'conflit · ' : 'moi : ') + draftText(d) }));
      if (state.synced[g.id] !== d.timestamp) out.push(h('span', { class: 'badge warn', text: 'non envoyée' }));
    }
    if (!out.length) out.push(h('span', { class: 'badge', text: 'à décider' }));
    return out;
  }

  /* ---------- liste ---------- */
  function haystack(g) {
    if (!g._hay) {
      g._hay = norm([g.n, g.aiVerdicts].concat(g.records.map(function (r) {
        return [r.key, r.title, r.authors, r.year, r.doi].join(' ');
      })).join(' ')) + ' ' + g.records.map(function (r) { return (r.doi || '').toLowerCase(); }).join(' ');
    }
    return g._hay;
  }
  function visibleGroups() {
    var q = norm(state.search);
    return state.groups.filter(function (g) {
      if (state.filter === 'todo' && isDecided(g)) return false;
      if (state.filter === 'done' && !isDecided(g)) return false;
      return !q || haystack(g).indexOf(q) !== -1;
    });
  }
  function renderList() {
    var list = $('group-list'), vis = visibleGroups();
    list.textContent = '';
    vis.forEach(function (g) {
      var btn = h('button', {
        type: 'button', 'data-id': g.id, 'aria-current': g.id === state.currentId ? 'true' : 'false',
        onclick: function () { selectGroup(g.id, true); }
      },
        h('span', { class: 'g-title', text: g.records[0] ? g.records[0].title : g.id }),
        h('span', { class: 'g-meta' }, 'n° ' + g.n + ' · ' + g.records.length + ' notices · ' + g.aiVerdicts, badgesFor(g)));
      list.appendChild(h('li', null, btn));
    });
    var todo = state.groups.filter(function (g) { return !isDecided(g); }).length;
    $('list-count').textContent = vis.length + ' groupe(s) affiché(s) · ' + todo + ' à décider sur ' + state.groups.length;
  }

  function neighbour(step) {
    var vis = visibleGroups(), i = vis.findIndex(function (g) { return g.id === state.currentId; });
    if (!vis.length) return null;
    if (i === -1) return vis[0].id;
    var j = i + step;
    return j >= 0 && j < vis.length ? vis[j].id : null;
  }

  /* ---------- détail d'un groupe ---------- */
  var FIELDS = [
    { k: 'title', label: 'Titre', cls: 'title' },
    { k: 'authors', label: 'Auteurs' },
    { k: 'year', label: 'Année' },
    { k: 'doi', label: 'DOI', cls: 'mono', exact: true },
    { k: 'provider', label: 'Fournisseur' },
    { k: 'run', label: 'Run' },
    { k: 'collection', label: 'Collection' }
  ];
  function diffClasses(records) {
    var res = {};
    FIELDS.forEach(function (f) {
      var raw = new Set(records.map(function (r) { return String(r[f.k] || '').trim(); }));
      var n = new Set(records.map(function (r) { return f.exact ? String(r[f.k] || '').trim().toLowerCase() : norm(r[f.k]); }));
      res[f.k] = n.size > 1 ? 'diff' : raw.size > 1 ? 'soft' : '';
    });
    return res;
  }

  function selectGroup(id, focusDetail) {
    state.currentId = id;
    try { history.replaceState(null, '', id ? '#groupe-' + state.byId.get(id).n : '#'); } catch (e) { /* ignore */ }
    renderList();
    renderDetail();
    var cur = document.querySelector('#group-list button[aria-current=true]');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    if (focusDetail) $('detail').focus({ preventScroll: true });
  }

  function renderDetail() {
    var box = $('detail'), g = state.byId.get(state.currentId);
    box.textContent = '';
    if (!g) {
      box.appendChild(h('p', { class: 'muted' }, 'Choisissez un groupe dans la liste (raccourcis : n suivant, p précédent).'));
      return;
    }
    var diffs = diffClasses(g.records);
    var draft = draftOf(g);
    var excluded = new Set(draft && draft.decision === 'fusionner sauf' ? draft.keep_out : []);

    box.appendChild(h('div', { class: 'detail-head' },
      h('h2', null, 'Groupe n° ' + g.n),
      h('span', { class: 'muted' }, g.records.length + ' notices · ' + g.pairs.length + ' paire(s) · verdicts IA : ' + g.aiVerdicts),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', onclick: function () { var id = neighbour(-1); if (id) selectGroup(id, true); } }, '← Précédent'),
      h('button', { type: 'button', onclick: function () { var id = neighbour(1); if (id) selectGroup(id, true); } }, 'Suivant →')));
    box.appendChild(h('p', { class: 'legend' },
      h('span', { class: 'l-diff' }, 'valeur différente entre les notices'),
      h('span', { class: 'l-soft' }, 'différence de forme seulement (casse, ponctuation, accents)')));

    var cards = h('div', { class: 'cards' });
    cards.style.gridTemplateColumns = 'repeat(' + g.records.length + ', minmax(300px, 1fr))';
    g.records.forEach(function (r) { cards.appendChild(renderCard(r, diffs, excluded.has(r.key))); });
    box.appendChild(cards);

    box.appendChild(renderDecision(g, draft, cards));
    box.appendChild(renderAI(g));

    g.records.forEach(function (r) { loadLive(r); });
  }

  function renderCard(r, diffs, isOut) {
    var dl = h('dl', { class: 'fields' });
    FIELDS.forEach(function (f) {
      var v = r[f.k];
      var dd = h('dd', { class: [f.cls || '', diffs[f.k] || ''].join(' ').trim() || null });
      if (f.k === 'doi' && v) dd.appendChild(link('https://doi.org/' + doiPath(v), v, 'Résoudre le DOI'));
      else dd.textContent = v || '—';
      dl.appendChild(h('dt', null, f.label));
      dl.appendChild(dd);
    });
    var title = r.title || '';
    var q = encodeURIComponent(title);
    var tools = h('div', { class: 'tools', 'aria-label': 'Outils de vérification' },
      r.doi ? link('https://doi.org/' + doiPath(r.doi), 'doi.org') : null,
      r.link ? link(r.link, 'Lien de la notice') : null,
      title ? link('https://pubmed.ncbi.nlm.nih.gov/?term=' + q, 'PubMed') : null,
      title ? link('https://scholar.google.com/scholar?q=' + encodeURIComponent('"' + title + '"'), 'Google Scholar') : null,
      title ? link('https://slsp-unige.primo.exlibrisgroup.com/discovery/search?vid=41SLSP_UGE:VU1&query=any,contains,' + q, 'swisscovery UNIGE') : null,
      h('a', { href: 'zotero://select/library/items/' + encodeURIComponent(r.key), title: 'Ouvre la notice dans Zotero installé sur cet ordinateur' }, 'Zotero (local)'));
    var live = h('div', { class: 'live', id: 'live-' + r.key, 'aria-live': 'polite' },
      h('h4', null, 'Métadonnées en direct'),
      h('p', { class: 'muted' }, r.doi ? 'Chargement…' : 'Pas de DOI : vérifier par le titre (PubMed, Scholar, swisscovery).'));
    var cb = h('input', { type: 'checkbox', class: 'keepout-cb', 'data-key': r.key, id: 'out-' + r.key, checked: isOut });
    return h('article', { class: 'card' + (isOut ? ' kept-out' : ''), 'aria-label': 'Notice ' + r.key },
      h('div', { class: 'card-head' },
        h('span', { class: 'key', text: r.key }),
        r.inExport ? null : h('span', { class: 'badge warn', text: 'absente de l\'export' })),
      dl, tools, live,
      h('label', { class: 'keepout', for: 'out-' + r.key }, cb, 'Exclure de la fusion (« Fusionner sauf… »)'));
  }

  function renderAI(g) {
    var sec = h('section', { class: 'ai', 'aria-labelledby': 'ai-title' }, h('h3', { id: 'ai-title' }, 'Avis de l\'IA'));
    var ul = h('ul');
    g.aiReasons.forEach(function (x) {
      ul.appendChild(h('li', null, x.verdict ? h('span', { class: 'badge info', text: x.verdict + (x.confiance ? ', ' + x.confiance : '') }) : null,
        x.verdict ? ' ' : null, x.text));
    });
    sec.appendChild(ul);
    if (g.pairs.length) {
      var tb = h('tbody');
      g.pairs.forEach(function (p) {
        tb.appendChild(h('tr', null,
          h('td', { class: 'mono' }, p.a + ' – ' + p.b),
          h('td', null, p.verdict), h('td', null, p.confiance), h('td', null, p.raison),
          h('td', null, p.verifications), h('td', null, p.decision || '—')));
      });
      sec.appendChild(h('table', { class: 'pairs' },
        h('caption', { class: 'sr-only' }, 'Verdicts IA par paire'),
        h('thead', null, h('tr', null, ['Paire', 'Verdict IA', 'Confiance', 'Raison', 'Vérifications faites', 'Décision de paire'].map(function (t) {
          return h('th', { scope: 'col' }, t);
        }))), tb));
    }
    if (g.pairDecisions) sec.appendChild(h('p', { class: 'muted small' }, 'Décisions de paires déjà saisies : ' + g.pairDecisions));
    return sec;
  }

  function renderDecision(g, draft, cards) {
    var form = h('form', { class: 'decision', 'aria-labelledby': 'dec-title' });
    form.appendChild(h('h3', { id: 'dec-title' }, 'Décision pour le groupe'));
    form.appendChild(h('p', { class: 'existing' }, 'Décision déjà saisie dans le CSV : ',
      g.decision ? h('strong', null, g.decision) : h('span', { class: 'muted' }, 'aucune')));
    if (draft) {
      form.appendChild(h('p', { class: 'existing' }, 'Ma décision (' + fmtDate(draft.timestamp) + ') : ', h('strong', null, draftText(draft)),
        state.synced[g.id] === draft.timestamp ? ' — envoyée sur GitHub' : ' — pas encore envoyée'));
    }
    var fs = h('fieldset', null, h('legend', null, 'Choix'));
    DECISIONS.forEach(function (d) {
      fs.appendChild(h('label', { class: 'choice' },
        h('input', { type: 'radio', name: 'decision', value: d.value, checked: !!(draft && draft.decision === d.value) }), d.label));
    });
    form.appendChild(fs);
    var hint = h('p', { class: 'muted small', id: 'sauf-hint' }, 'Pour « Fusionner sauf… », cochez « Exclure de la fusion » sur les notices à garder à part.');
    form.appendChild(hint);
    form.appendChild(h('label', { for: 'comment' }, 'Commentaire (facultatif)'));
    form.appendChild(h('textarea', { id: 'comment', name: 'comment' }, draft ? draft.comment || '' : ''));
    var msg = h('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
    form.appendChild(h('div', { class: 'row' },
      h('button', { type: 'submit', class: 'primary', 'data-next': '1' }, 'Enregistrer et passer au suivant'),
      h('button', { type: 'submit', 'data-next': '0' }, 'Enregistrer'),
      state.token ? h('button', { type: 'submit', 'data-next': 'push' }, 'Enregistrer et envoyer sur GitHub') : null,
      h('span', { class: 'grow' }),
      draft ? h('button', { type: 'button', class: 'danger', onclick: function () { clearDecision(g); } }, 'Effacer ma décision') : null));
    form.appendChild(msg);

    function syncKeepout() {
      var sel = form.querySelector('input[name=decision]:checked');
      var on = !!(sel && sel.value === 'fusionner sauf');
      cards.querySelectorAll('.keepout-cb').forEach(function (cb) {
        cb.disabled = !on;
        cb.closest('.card').classList.toggle('kept-out', on && cb.checked);
      });
      hint.hidden = !on;
    }
    form.addEventListener('change', syncKeepout);
    cards.addEventListener('change', syncKeepout);
    syncKeepout();

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var mode = (ev.submitter && ev.submitter.getAttribute('data-next')) || '0';
      var nxt = neighbour(1);
      if (!state.reviewer) { setMsg(msg, 'Définissez d\'abord votre nom de relecteur dans Réglages.', 'error'); openSettings(); return; }
      var sel = form.querySelector('input[name=decision]:checked');
      if (!sel) { setMsg(msg, 'Choisissez une décision.', 'error'); return; }
      var keepOut = [];
      if (sel.value === 'fusionner sauf') {
        cards.querySelectorAll('.keepout-cb:checked').forEach(function (cb) { keepOut.push(cb.getAttribute('data-key')); });
        keepOut.sort();
        if (!keepOut.length) { setMsg(msg, 'Cochez au moins une notice à exclure de la fusion.', 'error'); return; }
        if (g.keys.length - keepOut.length < 2) { setMsg(msg, 'Il doit rester au moins deux notices à fusionner.', 'error'); return; }
      }
      var entry = {
        decision: sel.value, keep_out: keepOut, comment: form.querySelector('#comment').value.trim(),
        reviewer: state.reviewer, timestamp: nowIso()
      };
      state.drafts[g.id] = entry;
      delete state.deleted[g.id];
      saveDrafts();
      if (g.decision && g.decision !== draftText(entry)) {
        alert('Attention : votre décision diffère de celle déjà saisie dans le CSV (« ' + g.decision + ' »). Elle sera signalée comme conflit à l\'ingestion, sans écraser le CSV.');
      }
      if (mode === 'push') await push();
      if (mode === '1') {
        refresh();
        if (nxt && nxt !== g.id) selectGroup(nxt, true);
      } else {
        refresh();
      }
    });
    return form;
  }

  function clearDecision(g) {
    if (!confirm('Effacer votre décision pour le groupe n° ' + g.n + ' ?' + (state.synced[g.id] ? ' Elle sera aussi retirée de GitHub au prochain envoi.' : ''))) return;
    if (state.synced[g.id]) state.deleted[g.id] = nowIso();
    delete state.drafts[g.id];
    delete state.synced[g.id];
    saveDrafts();
    refresh();
  }

  /* ---------- métadonnées en direct (CrossRef, OpenAlex, Unpaywall) ---------- */
  function cached(url) {
    if (!state.live.has(url)) {
      state.live.set(url, fetch(url, { headers: { Accept: 'application/json' } }).then(async function (r) {
        if (r.status === 404) return { notFound: true };
        if (!r.ok) return { error: 'HTTP ' + r.status };
        return { json: await r.json() };
      }).catch(function (e) { state.live.delete(url); return { error: 'erreur réseau' }; }));
    }
    return state.live.get(url);
  }
  function names(list, max) {
    var out = list.slice(0, max);
    return out.join(' ; ') + (list.length > max ? ' et al. (' + list.length + ')' : '');
  }
  function srcBlock(name, res, fn, record) {
    var div = h('div', { class: 'src' }, h('p', null, h('strong', null, name)));
    if (res.notFound) { div.classList.add('notfound'); div.appendChild(h('p', null, name === 'CrossRef' ? 'DOI introuvable' : 'Absent de ' + name)); return div; }
    if (res.error) { div.appendChild(h('p', { class: 'muted' }, 'Non disponible (' + res.error + ')')); return div; }
    var info = fn(res.json);
    var a = norm(info.title), b = norm(record.title);
    if (info.title !== undefined && b && a.indexOf(b) === -1 && b.indexOf(a) === -1) {   // préfixe « Letter to the Editor. » toléré
      div.classList.add('mismatch');
      info.lines.unshift(h('span', { class: 'badge warn', text: 'titre différent de la notice' }));
    }
    info.lines.forEach(function (l) { div.appendChild(h('p', null, l)); });
    return div;
  }
  function crossref(j) {
    var m = j.message || {};
    var t = (m.title || [])[0] || '';
    var y = ((m.issued || {})['date-parts'] || [[]])[0][0] || '';
    var a = (m.author || []).map(function (x) { return x.family ? x.family + (x.given ? ' ' + x.given.charAt(0) : '') : x.name || ''; });
    return { title: t, lines: [t || '(sans titre)', [(m['container-title'] || [])[0], m.type, y].filter(Boolean).join(' · '), a.length ? names(a, 6) : 'auteurs non indiqués'] };
  }
  function openalex(j) {
    var src = j.primary_location && j.primary_location.source;
    var a = (j.authorships || []).map(function (x) { return x.author && x.author.display_name; }).filter(Boolean);
    return { title: j.display_name || '', lines: [j.display_name || '(sans titre)', [src && src.display_name, j.type, j.publication_year].filter(Boolean).join(' · '), a.length ? names(a, 6) : 'auteurs non indiqués'] };
  }
  function unpaywall(j) {
    var loc = j.best_oa_location;
    if (j.is_oa && loc && (loc.url_for_pdf || loc.url)) {
      return { lines: [h('span', null, link(loc.url_for_pdf || loc.url, loc.url_for_pdf ? 'PDF en accès libre' : 'Version en accès libre'),
        ' (' + [loc.host_type === 'publisher' ? 'éditeur' : 'dépôt', loc.version, loc.license].filter(Boolean).join(', ') + ')')] };
    }
    return { lines: ['Pas de version en accès libre connue.'] };
  }
  async function loadLive(r) {
    if (!r.doi) return;
    var p = doiPath(r.doi), mail = encodeURIComponent(CONFIG.contactEmail);
    var results = await Promise.all([
      cached('https://api.crossref.org/works/' + p + '?mailto=' + mail),
      cached('https://api.openalex.org/works/doi:' + p + '?mailto=' + mail),
      cached('https://api.unpaywall.org/v2/' + p + '?email=' + mail)
    ]);
    var box = document.getElementById('live-' + r.key);
    if (!box) return;                                   // groupe changé entre-temps
    box.textContent = '';
    box.appendChild(h('h4', null, 'Métadonnées en direct'));
    box.appendChild(srcBlock('CrossRef', results[0], crossref, r));
    box.appendChild(srcBlock('OpenAlex', results[1], openalex, r));
    box.appendChild(srcBlock('Unpaywall', results[2], unpaywall, r));
  }

  /* ---------- onglets, clavier, démarrage ---------- */
  function setupTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('[role=tab]'));
    function activate(t, focus) {
      tabs.forEach(function (x) {
        var on = x === t;
        x.setAttribute('aria-selected', on ? 'true' : 'false');
        x.tabIndex = on ? 0 : -1;
        $(x.getAttribute('aria-controls')).hidden = !on;
      });
      if (focus) t.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { activate(t); });
      t.addEventListener('keydown', function (e) {
        var j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
        if (j === null) return;
        e.preventDefault();
        activate(tabs[(j + tabs.length) % tabs.length], true);
      });
    });
  }

  function refresh() { renderList(); renderDetail(); updateWho(); }

  var started = false;
  function startApp() {
    $('unlock').hidden = true;
    $('app').hidden = false;
    if (started) { refresh(); return; }
    started = true;
    loadReviewer();
    var m = /^#groupe-(\d+)$/.exec(location.hash);
    var fromHash = m && state.groups.find(function (g) { return String(g.n) === m[1]; });
    if (fromHash) { state.currentId = fromHash.id; if (isDecided(fromHash)) state.filter = 'all'; }
    document.querySelector('input[name=filter][value=' + state.filter + ']').checked = true;
    refresh();
    if (!state.reviewer) openSettings();
    else pull(true);
  }

  function init() {
    setupTabs();
    showManifest();
    $('unlock-form').addEventListener('submit', function (e) { e.preventDefault(); unlock($('passphrase').value, false); });
    $('lock').addEventListener('click', lock);
    $('open-settings').addEventListener('click', openSettings);
    $('settings-form').addEventListener('submit', saveSettings);
    $('settings-cancel').addEventListener('click', function () { $('settings').close(); });
    $('clear-token').addEventListener('click', clearToken);
    $('test-token').addEventListener('click', testToken);
    $('push-all').addEventListener('click', function () { push(); });
    $('download').addEventListener('click', download);
    document.querySelectorAll('input[name=filter]').forEach(function (r) {
      r.addEventListener('change', function () { state.filter = r.value; renderList(); });
    });
    $('search').addEventListener('input', function (e) { state.search = e.target.value; renderList(); });
    document.addEventListener('keydown', function (e) {
      if ($('app').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || $('settings').open) return;
      if (e.key === 'n' || e.key === 'p') {
        var id = neighbour(e.key === 'n' ? 1 : -1);
        if (id) { e.preventDefault(); selectGroup(id, true); }
      }
    });
    window.addEventListener('storage', function (e) {     // autre onglet du même navigateur
      if (e.key && e.key.indexOf('tbi-webui.') === 0 && started) { loadReviewer(); refresh(); }
    });
    var saved = sget('sessionStorage', KEYS.pass);
    if (saved) unlock(saved, true);
    else $('passphrase').focus();
  }

  if (!window.crypto || !window.crypto.subtle) {
    document.addEventListener('DOMContentLoaded', function () {
      $('unlock-msg').textContent = 'Ce navigateur ne permet pas le déchiffrement (WebCrypto indisponible : ouvrir la page en HTTPS).';
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
