/* ══════════════════════════════════════════
   osu!helper — Frontend Logic (v2)
   Supports local multi-profile + OAuth hosted mode
   ══════════════════════════════════════════ */

'use strict';

// ─── State ─────────────────────────────────
let topPlays      = [];
let currentRecs   = [];
let recMode       = 'profile';
let sseSource     = null;
let meData        = null;       // result of /api/me
let allProfiles   = [];         // local mode only
let activeProfileId = null;

const OAUTH_MODE = window.OAUTH_MODE === true;

// ─── Init ───────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  checkAuthError();
  await bootstrap();
});

async function bootstrap() {
  meData = await fetchMe();

  if (OAUTH_MODE) {
    if (!meData.logged_in) {
      showOAuthLogin();
      return;
    }
    showOAuthUserChip(meData);
    hideOAuthLogin();
  } else {
    hideOAuthLogin();
    if (!meData.has_credentials) {
      showSetupOverlay();
      return;
    }
    hideSetupOverlay();
    await loadProfiles();
    populateSettings(meData);
    startSSE();
  }

  await Promise.all([loadTopPlays(), loadUserInfo()]);
  loadRecommendations();
}

// ─── /api/me ────────────────────────────────
async function fetchMe() {
  try {
    const r = await fetch('/api/me');
    return await r.json();
  } catch (_) { return {}; }
}

// ─── OAuth UI ───────────────────────────────
function showOAuthLogin() {
  document.getElementById('oauth-login-screen').classList.remove('hidden');
}
function hideOAuthLogin() {
  document.getElementById('oauth-login-screen').classList.add('hidden');
}
function showOAuthUserChip(me) {
  const chip = document.getElementById('oauth-user-chip');
  document.getElementById('oauth-avatar').src    = me.avatar_url || '';
  document.getElementById('oauth-username').textContent = me.username || '—';
  document.getElementById('oauth-pp').textContent =
    me.pp ? `${Math.round(me.pp).toLocaleString()}pp` : '—';
  chip.classList.remove('hidden');
}

// ─── Local setup overlay ─────────────────────
function showSetupOverlay() { document.getElementById('setup-overlay').classList.remove('hidden'); }
function hideSetupOverlay() { document.getElementById('setup-overlay').classList.add('hidden'); }

document.getElementById('setup-btn')?.addEventListener('click', async () => {
  const username = document.getElementById('setup-username').value.trim();
  const cid      = document.getElementById('setup-client-id').value.trim();
  const csec     = document.getElementById('setup-client-secret').value.trim();
  const errEl    = document.getElementById('setup-error');
  const btnText  = document.getElementById('setup-btn-text');
  const spinner  = document.getElementById('setup-spinner');

  errEl.classList.add('hidden');
  btnText.textContent = 'Connecting…';
  spinner.classList.remove('hidden');

  const r    = await fetch('/api/test-credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cid, client_secret: csec, username }),
  });
  const data = await r.json();

  if (data.ok) {
    // Create first profile via API
    await fetch('/api/profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username, display_name: username, client_id: cid, client_secret: csec,
      }),
    });
    hideSetupOverlay();
    await bootstrap();
  } else {
    errEl.textContent = data.error || 'Authentication failed';
    errEl.classList.remove('hidden');
  }

  btnText.textContent = 'Connect to osu!';
  spinner.classList.add('hidden');
});

// ─── Profiles (local mode) ───────────────────
async function loadProfiles() {
  if (OAUTH_MODE) return;
  const r    = await fetch('/api/profiles');
  const data = await r.json();
  allProfiles   = data.profiles || [];
  activeProfileId = data.active_id;
  renderProfileSwitcher();
  renderProfilesList();

  document.getElementById('profile-switcher').classList.remove('hidden');
  document.getElementById('profiles-card').classList.remove('hidden');
  document.getElementById('credentials-card').classList.remove('hidden');

  // Populate credential fields for active profile
  const active = allProfiles.find(p => p.id === activeProfileId) || {};
  document.getElementById('settings-username').value    = active.username || '';
  document.getElementById('settings-client-id').value  = active.client_id || '';
  document.getElementById('settings-client-secret').value = '';
}

function renderProfileSwitcher() {
  const active = allProfiles.find(p => p.id === activeProfileId) || {};
  document.getElementById('profile-avatar').src = active.avatar_url || '';
  document.getElementById('profile-chip-name').textContent = active.display_name || active.username || '—';
  document.getElementById('profile-chip-pp').textContent =
    active.pp ? `${Math.round(active.pp).toLocaleString()}pp` : '—pp';

  const list = document.getElementById('profile-menu-list');
  list.innerHTML = allProfiles.map(p => `
    <button class="profile-menu-item ${p.id === activeProfileId ? 'active' : ''}"
            onclick="switchProfile('${p.id}')">
      <img src="${esc(p.avatar_url||'')}" alt="" class="avatar-sm"
           onerror="this.style.display='none'" />
      <div class="profile-item-info">
        <span class="profile-item-name">${esc(p.display_name || p.username)}</span>
        <span class="profile-item-pp">${p.pp ? Math.round(p.pp).toLocaleString()+'pp' : '—'}</span>
      </div>
      ${p.id === activeProfileId ? '<span class="active-check">✓</span>' : ''}
    </button>
  `).join('');
}

function renderProfilesList() {
  const list = document.getElementById('profiles-list');
  if (!list) return;
  list.innerHTML = allProfiles.map(p => `
    <div class="profile-row ${p.id === activeProfileId ? 'active-profile' : ''}">
      <img src="${esc(p.avatar_url||'')}" alt="" class="avatar-sm"
           onerror="this.style.display='none'" />
      <div class="profile-row-info">
        <span>${esc(p.display_name || p.username)}</span>
        <span class="profile-row-sub">${esc(p.username)}${p.global_rank ? ' · #'+p.global_rank.toLocaleString() : ''}</span>
      </div>
      <div class="profile-row-actions">
        ${p.id !== activeProfileId
          ? `<button class="btn btn-ghost btn-sm" onclick="switchProfile('${p.id}')">Switch</button>`
          : '<span class="active-badge">Active</span>'}
        ${allProfiles.length > 1
          ? `<button class="btn btn-ghost btn-sm btn-danger" onclick="deleteProfile('${p.id}')">✕</button>`
          : ''}
      </div>
    </div>
  `).join('');
}

function toggleProfileMenu() {
  document.getElementById('profile-menu').classList.toggle('hidden');
}
// Close menu on outside click
document.addEventListener('click', e => {
  const sw = document.getElementById('profile-switcher');
  if (sw && !sw.contains(e.target)) {
    document.getElementById('profile-menu')?.classList.add('hidden');
  }
});

async function switchProfile(id) {
  document.getElementById('profile-menu').classList.add('hidden');
  if (id === activeProfileId) return;
  await fetch(`/api/profiles/${id}/activate`, { method: 'POST' });
  toast('Switching profile…', 'info');
  // Reset state
  topPlays = [];
  activeProfileId = id;
  await loadProfiles();
  meData = await fetchMe();
  populateSettings(meData);
  await Promise.all([loadTopPlays(), loadUserInfo()]);
  loadRecommendations();
}

async function deleteProfile(id) {
  if (!confirm('Delete this profile?')) return;
  await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
  await loadProfiles();
  toast('Profile deleted', 'ok');
}

function openAddProfile() {
  document.getElementById('profile-menu')?.classList.add('hidden');
  document.getElementById('add-profile-modal').classList.remove('hidden');
}
function closeAddProfile() {
  document.getElementById('add-profile-modal').classList.add('hidden');
  ['ap-username','ap-display-name','ap-client-id','ap-client-secret'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('ap-error').classList.add('hidden');
}

async function submitAddProfile() {
  const username     = document.getElementById('ap-username').value.trim();
  const displayName  = document.getElementById('ap-display-name').value.trim();
  const clientId     = document.getElementById('ap-client-id').value.trim();
  const clientSecret = document.getElementById('ap-client-secret').value.trim();
  const errEl = document.getElementById('ap-error');
  const btnText = document.getElementById('ap-btn-text');
  const spinner = document.getElementById('ap-spinner');

  if (!username || !clientId || !clientSecret) {
    errEl.textContent = 'Username, Client ID and Client Secret are required.';
    errEl.classList.remove('hidden');
    return;
  }

  errEl.classList.add('hidden');
  btnText.textContent = 'Verifying…';
  spinner.classList.remove('hidden');

  // Test credentials first
  const tr = await fetch('/api/test-credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, client_id: clientId, client_secret: clientSecret }),
  });
  const td = await tr.json();

  if (!td.ok) {
    errEl.textContent = td.error || 'Could not verify credentials';
    errEl.classList.remove('hidden');
    btnText.textContent = 'Add Profile';
    spinner.classList.add('hidden');
    return;
  }

  await fetch('/api/profiles', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username, display_name: displayName || username,
      client_id: clientId, client_secret: clientSecret,
    }),
  });

  closeAddProfile();
  toast(`Profile "${username}" added!`, 'ok');
  await loadProfiles();
  btnText.textContent = 'Add Profile';
  spinner.classList.add('hidden');
}

// Save active profile credentials
async function saveActiveProfileCredentials() {
  const username = document.getElementById('settings-username').value.trim();
  const clientId = document.getElementById('settings-client-id').value.trim();
  const clientSecret = document.getElementById('settings-client-secret').value.trim();
  const body = { username, client_id: clientId };
  if (clientSecret && clientSecret !== '••••••••') body.client_secret = clientSecret;

  await fetch(`/api/profiles/${activeProfileId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  toast('Credentials saved', 'ok');
  await loadProfiles();
}

// ─── Settings ───────────────────────────────
function populateSettings(me) {
  document.getElementById('settings-top-n').value        = me.top_n          || 20;
  document.getElementById('settings-poll-interval').value = me.poll_interval || 30;
  document.getElementById('settings-rec-count').value    = me.rec_count      || 12;

  if (OAUTH_MODE) {
    document.getElementById('oauth-info-card').classList.remove('hidden');
    document.getElementById('poll-interval-group').classList.add('hidden');
  }
}

async function saveSettings() {
  const body = {
    top_n:         parseInt(document.getElementById('settings-top-n').value),
    poll_interval: parseInt(document.getElementById('settings-poll-interval').value),
    rec_count:     parseInt(document.getElementById('settings-rec-count').value),
  };
  const r = await fetch('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.ok) {
    const ok = document.getElementById('settings-save-ok');
    ok.classList.remove('hidden');
    setTimeout(() => ok.classList.add('hidden'), 2000);
    toast('Settings saved', 'ok');
  } else {
    toast('Failed to save settings', 'err');
  }
}

async function testCredentials() {
  const cid  = document.getElementById('settings-client-id').value.trim();
  const csec = document.getElementById('settings-client-secret').value.trim();
  const user = document.getElementById('settings-username').value.trim();
  const btn  = document.querySelector('[onclick="testCredentials()"]');
  const res  = document.getElementById('settings-test-result');
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  res.className = 'test-result hidden';

  try {
    const r = await fetch('/api/test-credentials', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: cid, client_secret: csec, username: user }),
    });
    const data = await r.json();
    if (data.ok) {
      res.className = 'test-result ok';
      res.textContent = `✓ Connected as ${data.user.username} · #${data.user.global_rank?.toLocaleString()} · ${Math.round(data.user.pp||0)}pp`;
    } else {
      res.className = 'test-result fail';
      res.textContent = `✗ ${data.error}`;
    }
  } catch (e) {
    res.className = 'test-result fail';
    res.textContent = `✗ Network error`;
  }

  res.classList.remove('hidden');
  if (btn) { btn.disabled = false; btn.textContent = 'Test Connection'; }
}

// ─── User Info ──────────────────────────────
async function loadUserInfo() {
  try {
    const r = await fetch('/api/user-info');
    if (!r.ok) return;
    const u = await r.json();
    if (u.error) return;

    if (OAUTH_MODE) {
      document.getElementById('oauth-avatar').src = u.avatar_url || '';
      document.getElementById('oauth-username').textContent = u.username || '—';
      document.getElementById('oauth-pp').textContent = u.pp ? `${Math.round(u.pp).toLocaleString()}pp` : '—';
    } else {
      // Refresh profile chip after user-info (which caches avatar/pp)
      await loadProfiles();
    }
  } catch (_) {}
}

// ─── Top Plays ──────────────────────────────
async function loadTopPlays() {
  showPlaysLoading();
  try {
    const r    = await fetch('/api/top-plays');
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    topPlays = data.plays || [];
    renderTopPlays(topPlays);
    document.getElementById('plays-subtitle').textContent = `Showing ${topPlays.length} best scores`;
  } catch (e) {
    showPlaysError(e.message);
  }
}

document.getElementById('refresh-plays-btn')?.addEventListener('click', loadTopPlays);

function showPlaysLoading() {
  document.getElementById('plays-loading').classList.remove('hidden');
  document.getElementById('plays-error').classList.add('hidden');
  document.getElementById('plays-grid').classList.add('hidden');
}
function showPlaysError(msg) {
  document.getElementById('plays-loading').classList.add('hidden');
  document.getElementById('plays-error').classList.remove('hidden');
  document.getElementById('plays-grid').classList.add('hidden');
  document.getElementById('plays-error-msg').textContent = msg;
}

function renderTopPlays(plays) {
  document.getElementById('plays-loading').classList.add('hidden');
  document.getElementById('plays-error').classList.add('hidden');
  const grid = document.getElementById('plays-grid');
  grid.classList.remove('hidden');
  grid.innerHTML = plays.map((p, i) => buildPlayCard(p, i)).join('');
}

function buildPlayCard(play, index) {
  const bm  = play.beatmap || {};
  const bms = play.beatmapset || {};
  const bmsId = bm.beatmapset_id || bms.id || 0;
  const bmId  = bm.id || 0;
  const cover = `https://assets.ppy.sh/beatmaps/${bmsId}/covers/cover.jpg`;
  const pp    = play.pp ? `${Math.round(play.pp)}pp` : '—';
  const acc   = play.accuracy ? `${(play.accuracy * 100).toFixed(2)}%` : '—';
  const sr    = bm.difficulty_rating ? bm.difficulty_rating.toFixed(2) : '?';
  const rankClass = `rank-${(play.rank || 'D').replace('H','')}`;
  const mods  = (play.mods || []).map(m => `<span class="mod-chip ${m}">${m}</span>`).join('');
  const title   = bms.title  || '?';
  const artist  = bms.artist || '';
  const version = bm.version || '';
  const creator = bms.creator || '';
  const date    = play.created_at ? new Date(play.created_at).toLocaleDateString() : '';
  const bpm     = bm.bpm ? `${Math.round(bm.bpm)} BPM` : '';
  const ar      = bm.ar  ? `AR${bm.ar.toFixed(1)}` : '';
  const length  = bm.total_length ? fmtLen(bm.total_length) : '';
  const starClass = starColorClass(parseFloat(sr));

  return `<div class="play-card">
  <div class="play-cover">
    <img src="${cover}" alt="" loading="lazy" onerror="this.style.opacity=0">
    <div class="play-cover-overlay"></div>
    <div class="play-rank-badge">#${index + 1}</div>
  </div>
  <div class="play-body">
    <div class="play-title-row">
      <div class="play-title">${esc(title)} <span>— ${esc(artist)}</span></div>
      <div class="play-diff-badge ${starClass}">★${sr}</div>
    </div>
    <div class="play-stats">
      <span class="stat-pill pp">${pp}</span>
      <span class="stat-pill ${rankClass}">${play.rank || '—'}</span>
      <span class="stat-pill">${acc}</span>
      ${play.max_combo ? `<span class="stat-pill">${play.max_combo}x</span>` : ''}
    </div>
    ${mods ? `<div class="mods-row">${mods}</div>` : ''}
    <div class="play-stats">
      ${ar ? `<span class="stat-pill">${ar}</span>` : ''}
      ${bpm ? `<span class="stat-pill">${bpm}</span>` : ''}
      ${length ? `<span class="stat-pill">${length}</span>` : ''}
      ${creator ? `<span class="stat-pill">by ${esc(creator)}</span>` : ''}
    </div>
  </div>
  <div class="play-footer">
    <span class="play-meta">${esc(version)} · ${date}</span>
    <div class="play-actions">
      <button class="btn btn-ghost btn-sm" onclick="loadRecsForPlay(${index})" title="Get recommendations similar to this map">🎯 Similar</button>
      <a href="https://osu.ppy.sh/b/${bmId}" target="_blank" class="btn btn-ghost btn-sm">View</a>
    </div>
  </div>
</div>`;
}

// ─── Recommendations ────────────────────────
async function loadRecommendations() {
  recMode = 'profile';
  document.getElementById('recs-title').textContent    = 'Recommendations';
  document.getElementById('recs-subtitle').textContent = 'Based on your overall taste profile';
  document.getElementById('recs-profile-btn').classList.add('active-mode');
  showRecsLoading();
  try {
    const r    = await fetch('/api/recommendations');
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    currentRecs = data.recommendations || [];
    renderRecs(currentRecs);
  } catch (e) {
    showRecsError(e.message);
  }
}

async function loadRecsForPlay(index) {
  recMode = `play:${index}`;
  const play  = topPlays[index];
  if (!play) return;
  const bms   = play.beatmapset || {};
  const title = bms.title || play.beatmap?.title || 'this map';
  document.getElementById('recs-title').textContent    = `Similar to: ${title}`;
  document.getElementById('recs-subtitle').textContent = `Maps like [${play.beatmap?.version || '?'}]`;
  document.getElementById('recs-profile-btn').classList.remove('active-mode');
  switchTab('recs');
  showRecsLoading();
  try {
    const r    = await fetch(`/api/recommendations/for-play/${index}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    currentRecs = data.recommendations || [];
    renderRecs(currentRecs);
  } catch (e) {
    showRecsError(e.message);
  }
}

function switchRecMode(mode) {
  if (mode === 'profile') loadRecommendations();
}

document.getElementById('refresh-recs-btn')?.addEventListener('click', () => {
  if (recMode === 'profile') loadRecommendations();
  else loadRecsForPlay(parseInt(recMode.split(':')[1]));
});

function showRecsLoading() {
  document.getElementById('recs-loading').classList.remove('hidden');
  document.getElementById('recs-error').classList.add('hidden');
  document.getElementById('recs-grid').classList.add('hidden');
}
function showRecsError(msg) {
  document.getElementById('recs-loading').classList.add('hidden');
  document.getElementById('recs-error').classList.remove('hidden');
  document.getElementById('recs-grid').classList.add('hidden');
  document.getElementById('recs-error-msg').textContent = msg;
}

function renderRecs(recs) {
  document.getElementById('recs-loading').classList.add('hidden');
  document.getElementById('recs-error').classList.add('hidden');
  const grid = document.getElementById('recs-grid');
  grid.classList.remove('hidden');
  if (!recs.length) {
    grid.innerHTML = `<div class="loading-state"><div class="error-icon">🔍</div><p>No recommendations found — try refreshing.</p></div>`;
    return;
  }
  grid.innerHTML = recs.map(buildRecCard).join('');
}

function buildRecCard(rec) {
  const bms   = rec.beatmapset || {};
  const bm    = rec.beatmap    || {};
  const bmsId = bms.id || 0;
  const bmId  = bm.id  || 0;
  const covers = bms.covers || {};
  const cover  = covers['cover@2x'] || covers['cover'] ||
                 `https://assets.ppy.sh/beatmaps/${bmsId}/covers/cover.jpg`;
  const sr    = bm.difficulty_rating ? bm.difficulty_rating.toFixed(2) : '?';
  const ar    = bm.ar    ? `AR${parseFloat(bm.ar).toFixed(1)}` : '';
  const od    = bm.accuracy ? `OD${parseFloat(bm.accuracy).toFixed(1)}` : '';
  const bpm   = bm.bpm || bms.bpm;
  const bpmStr = bpm ? `${Math.round(bpm)}BPM` : '';
  const length = bm.total_length ? fmtLen(bm.total_length) : '';
  const starClass = starColorClass(parseFloat(sr));
  const source    = rec.source === 'nerinyan' ? 'nerinyan' : 'osu!';
  const dlUrl  = `https://api.nerinyan.moe/d/${bmsId}`;
  const viewUrl = bm.url || `https://osu.ppy.sh/b/${bmId}`;

  return `<div class="rec-card">
  <div class="rec-cover">
    <img src="${cover}" alt="" loading="lazy" onerror="this.style.opacity=0">
    <div class="rec-cover-overlay"></div>
    <div class="rec-source-badge">${source}</div>
    <div class="rec-stars ${starClass}">★ ${sr}</div>
  </div>
  <div class="rec-body">
    <div class="rec-title">${esc(bms.title || '?')} <span class="rec-version">— ${esc(bm.version || '?')}</span></div>
    <div class="rec-mapper">${esc(bms.artist || '')} · mapped by ${esc(bms.creator || '?')}</div>
    <div class="rec-attrs">
      ${ar     ? `<span class="attr-chip ar">${ar}</span>` : ''}
      ${od     ? `<span class="attr-chip">${od}</span>` : ''}
      ${bpmStr ? `<span class="attr-chip bpm">${bpmStr}</span>` : ''}
      ${length ? `<span class="attr-chip">${length}</span>` : ''}
    </div>
    ${rec.reason ? `<div class="rec-reason">💡 ${esc(rec.reason)}</div>` : ''}
  </div>
  <div class="rec-actions">
    <a href="${viewUrl}" target="_blank" class="btn-outline">View</a>
    <a href="${dlUrl}" target="_blank" class="btn-outline btn-dl">Download</a>
    <a href="osu://b/${bmId}" class="btn-outline" title="Open in osu!">▶ Play</a>
  </div>
</div>`;
}

// ─── SSE ────────────────────────────────────
function startSSE() {
  if (OAUTH_MODE) return;  // SSE only in local mode
  if (sseSource) { sseSource.close(); sseSource = null; }
  sseSource = new EventSource('/events');
  sseSource.addEventListener('new_top_play', e => {
    try {
      const data = JSON.parse(e.data);
      showNewPlayBanner(data);
    } catch (_) {}
  });
  sseSource.onopen  = () => document.getElementById('live-dot').classList.remove('hidden');
  sseSource.onerror = () => {
    document.getElementById('live-dot').classList.add('hidden');
    setTimeout(startSSE, 10000);
  };
}

function showNewPlayBanner(data) {
  const play = data.play || {};
  const bms  = play.beatmapset || {};
  const bm   = play.beatmap    || {};
  const pp   = play.pp ? `${Math.round(play.pp)}pp` : '';
  document.getElementById('new-play-title').textContent =
    `${bms.title || '?'} [${bm.version || '?'}] ${pp ? '· ' + pp : ''}`;
  document.getElementById('new-play-banner').classList.remove('hidden');
  document.getElementById('new-play-view-btn').onclick = () => {
    document.getElementById('new-play-banner').classList.add('hidden');
    if (data.recommendations?.length) {
      document.getElementById('recs-title').textContent    = '🎉 New Top Play Recs';
      document.getElementById('recs-subtitle').textContent = `Similar to ${bms.title || '?'} [${bm.version || '?'}]`;
      document.getElementById('recs-profile-btn').classList.remove('active-mode');
      currentRecs = data.recommendations;
      renderRecs(currentRecs);
      switchTab('recs');
    }
    loadTopPlays();
  };
  document.getElementById('new-play-close').onclick = () =>
    document.getElementById('new-play-banner').classList.add('hidden');
  toast(`🎉 New top play: ${bms.title || '?'}!`, 'ok');
}

// ─── Auth error check ────────────────────────
function checkAuthError() {
  const params = new URLSearchParams(location.search);
  const err = params.get('auth_error');
  if (err) {
    toast(`Login failed: ${err}`, 'err');
    history.replaceState({}, '', '/');
  }
}

// ─── Tab navigation ──────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(s => s.classList.toggle('active', s.id === `tab-${name}`));
}

// ─── Toast ───────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ─── Helpers ────────────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtLen(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}:${String(s).padStart(2,'0')}`;
}
function starColorClass(sr) {
  if (sr < 2) return 'stars-1';
  if (sr < 3) return 'stars-2';
  if (sr < 4) return 'stars-3';
  if (sr < 5) return 'stars-4';
  if (sr < 6) return 'stars-5';
  if (sr < 7) return 'stars-6';
  return 'stars-7';
}

// Expose for inline onclick handlers
window.loadTopPlays                  = loadTopPlays;
window.loadRecommendations           = loadRecommendations;
window.loadRecsForPlay               = loadRecsForPlay;
window.switchRecMode                 = switchRecMode;
window.saveSettings                  = saveSettings;
window.testCredentials               = testCredentials;
window.saveActiveProfileCredentials  = saveActiveProfileCredentials;
window.toggleProfileMenu             = toggleProfileMenu;
window.switchProfile                 = switchProfile;
window.deleteProfile                 = deleteProfile;
window.openAddProfile                = openAddProfile;
window.closeAddProfile               = closeAddProfile;
window.submitAddProfile              = submitAddProfile;
