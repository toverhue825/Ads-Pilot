// Tabs + Videos, Library and Google Business screens. Shares helpers from app.js via window.AP.
const A = () => window.AP;
const $ = (s) => document.querySelector(s);
const e = (s) => A().esc(s);

// ---------- Tabs ----------
const TABS = ['ads', 'studio', 'videos', 'library', 'google'];
const loaded = new Set();
function showTab(name) {
  if (!TABS.includes(name)) name = 'ads';
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-only]').forEach((el) => { el.hidden = el.dataset.only !== name; });
  if (location.hash !== `#${name}`) history.replaceState(null, '', name === 'ads' ? location.pathname : `#${name}`);
  if (!window.AP || !A().me()) return; // app.js not finished loading; 'ap:ready' calls back in
  if (name === 'videos') loadVideos();
  if (name === 'library') loadLibrary();
  if (name === 'google') loadGoogle();
  loaded.add(name);
}
document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
const current = () => location.hash.replace('#', '') || 'ads';
showTab(current());
window.addEventListener('ap:ready', () => showTab(current()));
window.addEventListener('hashchange', () => showTab(current()));
window.addEventListener('ap:account', () => { if (current() === 'videos') loadVideos(); });

// ---------- Library ----------
let libKind = '', libTimer = null, libItems = [];
const dur = (ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}` : '');
async function loadLibrary() {
  const q = $('#libSearch').value.trim();
  const r = await A().api(`/api/library?q=${encodeURIComponent(q)}&kind=${libKind}`);
  const s = r.status;
  libItems = r.items;
  $('#libStatus').textContent = s.configured
    ? `${s.n ?? 0} files · ${s.photos ?? 0} photos · ${s.videos ?? 0} videos · ${s.tagged ?? 0} tagged · synced ${A().ago(s.lastSync)}`
    : 'Not connected yet';
  $('#libSync').hidden = !s.configured;
  $('#libSetup').innerHTML = s.configured ? (s.n ? '' : `<div class="empty"><div class="big">📂</div><b>Connected, but the folder is empty</b>
      <p class="muted">Drop photos and video clips into the shared Drive folder${s.serviceAccount ? ` (shared with <code>${e(s.serviceAccount)}</code>)` : ''}, then click Refresh. Subfolders are fine.</p></div>`)
    : `<div class="empty"><div class="big">🔗</div><b>Connect a Google Drive folder</b>
      <p class="muted">Add <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> and <code>GOOGLE_DRIVE_FOLDER_ID</code> in Render, then share the folder with the service account. Claude will describe and tag every photo and clip so you can search them here.</p></div>`;
  $('#libGrid').innerHTML = r.items.map((m) => `
    <figure class="lib-item" title="${e(m.name)}">
      <div class="lib-thumb">${m.kind === 'video' ? `<span class="badge">▶ ${dur(m.duration_ms)}</span>` : ''}
        <img loading="lazy" src="/api/library/${encodeURIComponent(m.id)}/thumb" alt="${e(m.description ?? m.name)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'Preview pending'}))"></div>
      <figcaption><b>${e(m.description ?? m.name)}</b>
        <div class="tags">${(m.tags ?? []).slice(0, 6).map((t) => `<button type="button" data-tag="${e(t)}">${e(t)}</button>`).join('')}</div>
        <div class="muted small">${e(m.folder || 'Top folder')}${m.quality ? ` · ${e(m.quality)}` : ''}${m.web_link ? ` · <a href="${e(m.web_link)}" target="_blank" rel="noopener">Open in Drive</a>` : ''}</div></figcaption>
    </figure>`).join('') || (s.n ? '<p class="muted">Nothing matches that search.</p>' : '');
}
$('#libSearch').addEventListener('input', () => { clearTimeout(libTimer); libTimer = setTimeout(loadLibrary, 250); });
document.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
  libKind = b.dataset.kind;
  document.querySelectorAll('[data-kind]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  loadLibrary();
}));
$('#libGrid').addEventListener('click', (ev) => { const t = ev.target.closest('[data-tag]'); if (t) { $('#libSearch').value = t.dataset.tag; loadLibrary(); } });
$('#libSync').addEventListener('click', async (ev) => {
  const b = ev.target; b.disabled = true; b.textContent = '↻ Refreshing… (new files get tagged, ~1 min)';
  const r = await A().api('/api/library/sync', { method: 'POST' });
  b.disabled = false; b.textContent = '↻ Refresh from Drive';
  A().toast(r.ok ? (r.busy ? 'Already refreshing.' : `Library up to date: ${r.files} files, ${r.tagged} newly tagged.`) : r.error);
  loadLibrary(); A().loadHealth();
});

// ---------- Videos ----------
const STAGE_LABEL = { idea: '💡 Idea', script: '📝 Script', filming: '🎥 Filming', editing: '✂️ Editing', ready: '✅ Ready', live: '📣 Live' };
let videos = [], stages = [];
async function loadVideos() {
  const acct = A().account();
  const r = await A().api(`/api/videos?x=1${acct ? `&account=${encodeURIComponent(acct)}` : ''}`);
  videos = r.videos; stages = r.stages;
  $('#angleList').innerHTML = A().latestAngles().map((a) => `<option value="${e(a)}">`).join('');
  $('#videoGo').disabled = !acct || !A().me().aiEnabled;
  $('#videoNote').textContent = !A().me().aiEnabled ? 'Turn on AI (ANTHROPIC_API_KEY) to use the Video Studio.' : !acct ? 'Pick a brand at the top first.'
    : 'About 30–60 seconds and a few cents. Uses clips already in your library where they fit.';
  $('#board').innerHTML = stages.map((s) => {
    const list = videos.filter((v) => v.status === s);
    return `<div class="col"><h3>${STAGE_LABEL[s]} <span class="muted">${list.length || ''}</span></h3>
      ${list.map((v) => `<button type="button" class="vcard" data-video="${v.id}"><b>${e(v.title)}</b>
        <span class="muted small">${v.request.length}s · ${v.request.format.startsWith('square') ? 'square' : 'vertical'}${v.plan?.missing_shots?.length ? ` · ${v.plan.missing_shots.length} to film` : ''}</span></button>`).join('')
        || '<p class="muted small">—</p>'}</div>`;
  }).join('');
}
function renderVideo(v) {
  const d = $('#videoDetail');
  if (!v) { d.hidden = true; return; }
  const p = v.plan;
  const thumb = (id) => (id ? `<img src="/api/library/${encodeURIComponent(id)}/thumb" alt="" loading="lazy">` : '<div class="noimg">To film</div>');
  d.hidden = false;
  d.innerHTML = `<div class="card-head" style="flex-wrap:wrap"><h2>${e(p.title)}</h2>
      <span class="sub">${v.request.length}s · ${e(v.request.format)}</span><span class="spacer"></span>
      <label class="muted small">Stage <select class="plain-select" data-stage="${v.id}">${stages.map((s) => `<option value="${s}" ${s === v.status ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}</select></label>
      <button class="btn btn-ghost" type="button" data-copyvideo="${v.id}">Copy script</button></div>
    <p class="ai-summary"><b>Hook:</b> ${e(p.hook)}</p>
    <ol class="beats">${p.beats.map((b) => `<li><div class="bthumb">${thumb(b.media_id)}</div>
      <div><span class="time">${b.start}–${b.end}s</span> ${e(b.visual)}
        ${b.on_screen_text ? `<div class="ost">“${e(b.on_screen_text)}”</div>` : ''}
        ${b.voiceover ? `<div class="muted small">🎙 ${e(b.voiceover)}</div>` : ''}</div></li>`).join('')}</ol>
    <div class="ai-grid">
      <div class="ai-box"><h3>📣 Caption &amp; call to action</h3><p style="margin:0">${e(p.caption)}</p><p class="muted small" style="margin:6px 0 0">End card: ${e(p.cta)}</p></div>
      <div class="ai-box"><h3>🎥 Still to film</h3>${p.missing_shots.length ? `<ul>${p.missing_shots.map((m) => `<li><b>${e(m.shot)}</b><br><span class="muted small">${e(m.how)}</span></li>`).join('')}</ul>` : '<p class="muted" style="margin:0">Nothing. Every shot is in your library.</p>'}</div>
      <div class="ai-box"><h3>✂️ Editing notes</h3><p style="margin:0">${e(p.editing_notes)}</p><p class="muted small" style="margin:6px 0 0">Music: ${e(p.music)}</p></div>
    </div>
    <p class="muted small">When it's finished, drop the video into your Drive folder (e.g. "Finished videos") and move it to Ready.</p>`;
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#board').addEventListener('click', (ev) => { const c = ev.target.closest('[data-video]'); if (c) renderVideo(videos.find((v) => v.id === Number(c.dataset.video))); });
$('#videoDetail').addEventListener('change', async (ev) => {
  const s = ev.target.closest('[data-stage]'); if (!s) return;
  const r = await A().api(`/api/videos/${s.dataset.stage}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: s.value }) });
  if (!r.ok) A().toast(r.error);
  await loadVideos();
});
$('#videoDetail').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-copyvideo]'); if (!b) return;
  const v = videos.find((x) => x.id === Number(b.dataset.copyvideo)); const p = v.plan;
  const text = `${p.title}\nHook: ${p.hook}\n\n` + p.beats.map((x) => `${x.start}-${x.end}s: ${x.visual}${x.on_screen_text ? `\n  TEXT: ${x.on_screen_text}` : ''}${x.voiceover ? `\n  VO: ${x.voiceover}` : ''}`).join('\n')
    + `\n\nCaption: ${p.caption}\nEnd card: ${p.cta}\nMusic: ${p.music}\n\nStill to film:\n${p.missing_shots.map((m) => `- ${m.shot} (${m.how})`).join('\n') || '- nothing'}\n\nEditing: ${p.editing_notes}`;
  try { await navigator.clipboard.writeText(text); b.textContent = 'Copied ✓'; } catch { b.textContent = 'Select & copy'; }
});
$('#videoForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, b = $('#videoGo');
  b.disabled = true; b.innerHTML = '<span class="dots">Planning</span>';
  const r = await A().api('/api/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: A().account(), idea: f.elements.idea.value, offer: f.elements.offer.value, length: f.elements.length.value, format: f.elements.format.value }) });
  b.disabled = false; b.textContent = '✦ Plan the video';
  if (!r.ok) { A().toast(r.error); return; }
  await loadVideos(); renderVideo(r.video); A().loadActivity();
});

// ---------- Google Business ----------
const STAR = (n) => `<span class="stars" aria-label="${n} stars">${'★'.repeat(n ?? 0)}<span>${'★'.repeat(5 - (n ?? 0))}</span></span>`;
async function loadGoogle() {
  const g = await A().api('/api/gbp');
  const setup = $('#gbpSetup');
  if (!g.configured) {
    setup.innerHTML = `<section class="card"><div class="empty"><div class="big">📍</div><b>Connect Google Business Profile</b>
      <p class="muted">Needs a Google sign-in app (<code>GOOGLE_OAUTH_CLIENT_ID</code> / <code>GOOGLE_OAUTH_CLIENT_SECRET</code> in Render) and Google's approval for Business Profile API access. See the README's Google setup section.</p></div></section>`;
  } else if (!g.connected) {
    setup.innerHTML = `<section class="card"><div class="empty"><div class="big">📍</div><b>Connect your Google Business Profile</b>
      <p class="muted">Sign in with the Google account that manages your Business Profile <b>and</b> your Google Ads. One sign-in connects both; you'll approve "Manage your business listings" and "Manage your AdWords campaigns" once.</p>
      <a class="btn btn-primary" href="/google/connect">Connect with Google</a></div></section>`;
  } else if (!g.location) {
    setup.innerHTML = `<section class="card"><div class="card-head"><h2>Pick your Business Profile location</h2><span class="sub">Google Ads works without this; its campaigns show on the Ads tab.</span></div><div id="gbpLocs"><p class="muted">Loading your locations…</p></div></section>`;
    const r = await A().api('/api/gbp/locations');
    $('#gbpLocs').innerHTML = !r.ok ? `<p class="error">${e(r.error)}</p>`
      : r.locations.length ? r.locations.map((l, i) => `<button class="btn btn-ghost loc" type="button" data-loc="${i}"><b>${e(l.title)}</b> <span class="muted">${e(l.address)}</span></button>`).join('')
      : '<p class="muted">No locations found for this Google account.</p>';
    $('#gbpLocs').onclick = async (ev) => {
      const b = ev.target.closest('[data-loc]'); if (!b) return;
      const x = await A().api('/api/gbp/location', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.locations[Number(b.dataset.loc)]) });
      if (!x.ok) return A().toast(x.error);
      A().toast('Location saved. Pulling reviews and stats…');
      await A().api('/api/gbp/sync', { method: 'POST' }); loadGoogle();
    };
  } else {
    setup.innerHTML = `<section class="card gbp-bar"><b>📍 ${e(g.location.title)}</b><span class="muted small">Synced ${A().ago(g.lastSync)}</span><span class="spacer"></span>
      <button class="btn btn-ghost" type="button" id="gbpSync">↻ Sync now</button></section>`;
    $('#gbpSync').onclick = async (ev) => {
      ev.target.disabled = true; const r = await A().api('/api/gbp/sync', { method: 'POST' });
      A().toast(r.ok ? `Synced. ${r.newReviews ?? 0} new review(s).` : r.error); loadGoogle(); A().loadHealth();
    };
  }
  const ready = g.connected && g.location;
  document.querySelectorAll('[data-panel="google"] > .cols, #gbpStats').forEach((el) => { el.hidden = !ready; });
  if (!ready) return;

  // Stats (last 28 days vs the 28 before)
  const st = g.stats;
  const tile = (label, key, help) => {
    const c = st?.current?.[key], p = st?.previous?.[key];
    const ch = p ? (c - p) / p : null;
    return `<div class="kpi"><div class="label">${label} <span class="help" title="${e(help)}">?</span></div><div class="value">${c == null ? '–' : A().fmt.int(c)}</div>
      <div class="delta ${ch == null || Math.abs(ch) < 0.005 ? '' : ch > 0 ? 'good' : 'bad'}">${ch == null ? 'Last 28 days' : `${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch * 100).toFixed(0)}% vs previous 28 days`}</div></div>`;
  };
  $('#gbpStats').innerHTML = tile('Profile views', 'views', 'Times your profile showed in Google Search and Maps.')
    + tile('Calls', 'calls', 'Taps on the Call button.') + tile('Website clicks', 'website', 'Clicks to your website from the profile.')
    + tile('Direction requests', 'directions', 'People asking for directions to you.');

  // Reviews
  const rv = g.reviews;
  $('#gbpReviewSub').textContent = rv.n ? `${rv.n} reviews · ${Number(rv.avg).toFixed(1)}★ average · ${rv.unanswered} unanswered` : '';
  $('#gbpReviews').innerHTML = g.reviewList.map((r) => `
    <div class="review ${r.reply ? '' : 'open'}">
      <div class="rhead">${STAR(r.stars)} <b>${e(r.reviewer)}</b> <span class="muted small">${A().ago(r.created_at)}</span></div>
      <p>${e(r.comment || '(rating only)')}</p>
      ${r.reply ? `<div class="reply"><span class="muted small">Your reply</span><p>${e(r.reply)}</p></div>`
        : `<textarea data-draft="${e(r.name)}" rows="3" placeholder="Write a reply…">${e(r.draft ?? '')}</textarea>
           <div class="row"><span class="muted small">${r.draft ? '✦ Drafted by Claude. Edit as you like.' : ''}</span><button class="btn btn-primary" type="button" data-reply="${e(r.name)}">Post reply</button></div>`}
    </div>`).join('') || '<p class="muted">No reviews yet.</p>';

  // Posts
  $('#gbpPosts').innerHTML = g.posts.map((p) => `
    <div class="gpost ${p.status}">
      ${p.media_id ? `<img src="/api/library/${encodeURIComponent(p.media_id)}/thumb" alt="">` : ''}
      ${p.status === 'posted' ? `<p>${e(p.summary)}</p><span class="muted small">Posted ${A().ago(p.posted_at)}</span>`
        : `<textarea data-post="${p.id}" rows="4">${e(p.summary)}</textarea>
           <input data-posturl="${p.id}" value="${e(p.cta_url ?? '')}" placeholder="Button link (https://…)" ${p.cta_type === 'CALL' ? 'hidden' : ''}>
           ${p.error ? `<p class="error small">${e(p.error)}</p>` : ''}
           <div class="row"><span class="muted small">Button: ${e(p.cta_type)}</span><button class="btn btn-primary" type="button" data-publishpost="${p.id}">Post to Google</button></div>`}
    </div>`).join('') || '<p class="muted small">No posts yet. Draft one above.</p>';

  // Photo picker for posts
  const lib = await A().api('/api/library?kind=photo');
  const sel = $('#gbpPostForm').elements.mediaId; const keep = sel.value;
  sel.innerHTML = '<option value="">No photo</option>' + lib.items.filter((m) => m.quality !== 'poor').slice(0, 80)
    .map((m) => `<option value="${e(m.id)}">${e((m.description ?? m.name).slice(0, 70))}</option>`).join('');
  sel.value = keep;
}
$('#gbpReviews').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-reply]'); if (!b) return;
  const text = document.querySelector(`[data-draft="${CSS.escape(b.dataset.reply)}"]`).value;
  b.disabled = true;
  const r = await A().api('/api/gbp/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: b.dataset.reply, text }) });
  b.disabled = false;
  A().toast(r.ok ? 'Reply posted on Google ✓' : r.error);
  if (r.ok) { loadGoogle(); A().loadActivity(); }
});
$('#gbpPosts').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-publishpost]'); if (!b) return;
  const id = b.dataset.publishpost;
  b.disabled = true;
  const r = await A().api(`/api/gbp/posts/${id}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: document.querySelector(`[data-post="${id}"]`).value, cta_url: document.querySelector(`[data-posturl="${id}"]`)?.value }) });
  b.disabled = false;
  A().toast(r.ok ? 'Posted to Google ✓' : r.error);
  loadGoogle(); if (r.ok) A().loadActivity();
});
$('#gbpPostForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, b = f.querySelector('button');
  b.disabled = true; b.innerHTML = '<span class="dots">Drafting</span>';
  const r = await A().api('/api/gbp/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: f.elements.topic.value, mediaId: f.elements.mediaId.value, account: A().account() }) });
  b.disabled = false; b.textContent = '✦ Draft post';
  if (!r.ok) return A().toast(r.error);
  f.elements.topic.value = ''; loadGoogle();
});
