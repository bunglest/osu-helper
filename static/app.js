/* ══════════════════════════════════════════
   osu!helper — Frontend Logic (v2)
   Supports local multi-profile + OAuth hosted mode
   ══════════════════════════════════════════ */

'use strict';

// ─── State ─────────────────────────────────
let topPlays      = [];
let currentRecs   = [];
let recMode       = 'profile';
let activeCat     = 'all';       // active category filter
let activeStatus    = 'all';       // 'all' | 'ranked' | 'loved'
let activeModFilter = '';          // '' = all mods, 'DT' = DT only, etc.
let sseSource     = null;
let meData        = null;       // result of /api/me
let allProfiles   = [];         // local mode only
let activeProfileId = null;
let selectedMods  = [];         // mods chosen in settings UI
let likedBmsIds      = new Set();  // beatmapset IDs the player has liked
let blockedMappers   = new Set();  // lowercase creator names the player has blocked

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
    populateSettings(meData);
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

  await Promise.all([loadTopPlays(), loadUserInfo(), loadLikedIds(), loadBlockedMappers()]);
  loadRecommendations();
}

// ─── Blocked mappers loader ──────────────────
async function loadBlockedMappers() {
  try {
    const r = await fetch('/api/blocked-mappers');
    if (!r.ok) return;
    const data = await r.json();
    blockedMappers = new Set((data.blocked || []).map(s => s.toLowerCase()));
  } catch (_) {}
}

// ─── Liked IDs loader ───────────────────────
async function loadLikedIds() {
  try {
    const r = await fetch('/api/feedback');
    if (!r.ok) return;
    const data = await r.json();
    likedBmsIds = new Set((data.liked || []).map(Number));
  } catch (_) {}
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
  try {
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
  } catch (_) {
    toast('Could not load profiles', 'err');
  }
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
  const profile = allProfiles.find(p => p.id === id);
  const name = profile?.display_name || profile?.username || 'this profile';
  showConfirm(
    'Delete profile',
    `Are you sure you want to remove "${name}"? This cannot be undone.`,
    async () => {
      try {
        await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
        await loadProfiles();
        toast('Profile deleted', 'ok');
      } catch (_) {
        toast('Could not delete profile', 'err');
      }
    }
  );
}

// ─── Inline confirm modal ────────────────────
function showConfirm(title, msg, onOk) {
  const modal = document.getElementById('confirm-modal');
  if (!modal) { if (window.confirm(msg)) onOk(); return; }
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-msg').textContent   = msg;
  modal.classList.remove('hidden');

  const okBtn     = document.getElementById('confirm-ok-btn');
  const cancelBtn = document.getElementById('confirm-cancel-btn');

  function cleanup() {
    modal.classList.add('hidden');
    okBtn.removeEventListener('click', handleOk);
    cancelBtn.removeEventListener('click', cleanup);
  }
  function handleOk() { cleanup(); onOk(); }

  okBtn.addEventListener('click', handleOk);
  cancelBtn.addEventListener('click', cleanup);
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

  // Rec preferences
  const srMin = me.sr_min != null ? me.sr_min : '';
  const srMax = me.sr_max != null ? me.sr_max : '';
  document.getElementById('settings-sr-min').value = srMin;
  document.getElementById('settings-sr-max').value = srMax;
  const useRecent = me.use_recent_plays !== false;
  document.getElementById('settings-use-recent').checked = useRecent;

  // Mod toggles
  selectedMods = Array.isArray(me.preferred_mods) ? [...me.preferred_mods] : [];
  syncModToggles();

  if (OAUTH_MODE) {
    document.getElementById('oauth-info-card').classList.remove('hidden');
    document.getElementById('poll-interval-group').classList.add('hidden');
  }
}

function syncModToggles() {
  document.querySelectorAll('.mod-toggle').forEach(btn => {
    const mod = btn.dataset.mod;
    const active = mod === 'NM'
      ? selectedMods.length === 0
      : selectedMods.includes(mod);
    btn.classList.toggle('active', active);
  });
}

// Wire mod toggle clicks
document.addEventListener('click', e => {
  const btn = e.target.closest('.mod-toggle');
  if (!btn) return;
  const mod = btn.dataset.mod;
  if (mod === 'NM') {
    selectedMods = [];
  } else {
    const idx = selectedMods.indexOf(mod);
    if (idx >= 0) selectedMods.splice(idx, 1);
    else selectedMods.push(mod);
  }
  syncModToggles();
});

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

async function saveRecPrefs() {
  const srMinVal = document.getElementById('settings-sr-min').value.trim();
  const srMaxVal = document.getElementById('settings-sr-max').value.trim();
  const body = {
    preferred_mods:   selectedMods,
    sr_min:           srMinVal !== '' ? parseFloat(srMinVal) : null,
    sr_max:           srMaxVal !== '' ? parseFloat(srMaxVal) : null,
    use_recent_plays: document.getElementById('settings-use-recent').checked,
  };
  const r = await fetch('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.ok) {
    const ok = document.getElementById('recprefs-save-ok');
    ok.classList.remove('hidden');
    setTimeout(() => ok.classList.add('hidden'), 2000);
    toast('Preferences saved', 'ok');
  } else {
    toast('Failed to save preferences', 'err');
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
  document.getElementById('plays-empty')?.classList.add('hidden');
  document.getElementById('plays-grid').classList.add('hidden');
}
function showPlaysError(msg) {
  document.getElementById('plays-loading').classList.add('hidden');
  document.getElementById('plays-error').classList.remove('hidden');
  document.getElementById('plays-empty')?.classList.add('hidden');
  document.getElementById('plays-grid').classList.add('hidden');
  document.getElementById('plays-error-msg').textContent = msg;
}

function renderTopPlays(plays) {
  document.getElementById('plays-loading').classList.add('hidden');
  document.getElementById('plays-error').classList.add('hidden');
  const emptyEl = document.getElementById('plays-empty');
  const grid = document.getElementById('plays-grid');
  if (!plays.length) {
    emptyEl?.classList.remove('hidden');
    grid.classList.add('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');
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
    ${renderTypeBadges(bm.map_types)}
  </div>
  <div class="play-footer">
    <span class="play-meta">${esc(version)} · ${date}</span>
    <div class="play-actions">
      <button class="btn-preview" onclick="togglePreview(${bmsId}, this)" title="Preview audio">▶</button>
      <button class="btn btn-ghost btn-sm" onclick="loadRecsForPlay(${index})" title="Get recommendations similar to this map">🎯 Similar</button>
      <a href="https://osu.ppy.sh/b/${bmId}" target="_blank" class="btn btn-ghost btn-sm">View</a>
    </div>
  </div>
</div>`;
}

// ─── Recommendations ────────────────────────
async function loadRecommendations() {
  recMode = 'profile';
  const modLabel = activeModFilter ? ` · ${activeModFilter} plays only` : '';
  document.getElementById('recs-title').textContent    = 'Recommendations';
  document.getElementById('recs-subtitle').textContent = `Based on your overall taste profile${modLabel}`;
  document.getElementById('recs-profile-btn').classList.add('active-mode');
  showRecsLoading();
  try {
    const url = activeModFilter
      ? `/api/recommendations?mod_filter=${encodeURIComponent(activeModFilter)}`
      : '/api/recommendations';
    const r    = await fetch(url);
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
  document.getElementById('recs-empty-cat')?.classList.add('hidden');
}
function showRecsError(msg) {
  document.getElementById('recs-loading').classList.add('hidden');
  document.getElementById('recs-error').classList.remove('hidden');
  document.getElementById('recs-grid').classList.add('hidden');
  document.getElementById('recs-empty-cat')?.classList.add('hidden');
  document.getElementById('recs-error-msg').textContent = msg;
}

function renderRecs(recs) {
  document.getElementById('recs-loading').classList.add('hidden');
  document.getElementById('recs-error').classList.add('hidden');
  const emptyCat = document.getElementById('recs-empty-cat');
  const grid = document.getElementById('recs-grid');

  let filtered = activeCat === 'all'
    ? recs
    : recs.filter(r => (r.category || 'best_match') === activeCat);
  if (activeStatus !== 'all') {
    filtered = filtered.filter(r => {
      const s = (r.beatmapset?.status || '').toLowerCase();
      if (activeStatus === 'ranked') return s === 'ranked' || s === 'approved';
      if (activeStatus === 'loved')  return s === 'loved';
      return true;
    });
  }

  if (!recs.length) {
    grid.classList.remove('hidden');
    emptyCat?.classList.add('hidden');
    grid.innerHTML = `<div class="loading-state"><div class="error-icon">🔍</div><p>No recommendations found — try refreshing.</p></div>`;
    return;
  }
  if (!filtered.length) {
    grid.classList.add('hidden');
    if (emptyCat) {
      emptyCat.classList.remove('hidden');
      emptyCat.textContent = 'No recommendations in this category yet.';
    }
    return;
  }
  emptyCat?.classList.add('hidden');
  grid.classList.remove('hidden');
  grid.innerHTML = filtered.map(buildRecCard).join('');
}

// ─── Category tabs ────────────────────────────
document.addEventListener('click', e => {
  const tab = e.target.closest('.cat-tab');
  if (tab) {
    activeCat = tab.dataset.cat;
    document.querySelectorAll('.cat-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.cat === activeCat));
    renderRecs(currentRecs);
  }
  const sbtn = e.target.closest('.status-btn');
  if (sbtn) {
    activeStatus = sbtn.dataset.status;
    document.querySelectorAll('.status-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.status === activeStatus));
    renderRecs(currentRecs);
  }
  const mpbtn = e.target.closest('.mod-profile-btn');
  if (mpbtn) {
    activeModFilter = mpbtn.dataset.modfilter;
    document.querySelectorAll('.mod-profile-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.modfilter === activeModFilter));
    loadRecommendations();
  }
});

// ─── Dismiss ──────────────────────────────────
async function dismissRec(bmsId, cardEl) {
  // Find rec data so we can send bm/bms for the disliked-vector store
  const rec = currentRecs.find(r => (r.beatmapset || {}).id === bmsId) || {};
  try {
    await fetch('/api/dismissed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        beatmapset_id: bmsId,
        bm:  rec.beatmap    || {},
        bms: rec.beatmapset || {},
      }),
    });
    // Remove from local state
    currentRecs = currentRecs.filter(r => (r.beatmapset || {}).id !== bmsId);
    // Animate card out
    if (cardEl) {
      cardEl.classList.add('dismissing');
      setTimeout(() => { cardEl.remove(); }, 300);
    }
    toast('Map dismissed', 'info');
  } catch (e) {
    toast('Could not dismiss map', 'err');
  }
}

// ─── Like / Unlike ────────────────────────────
async function likeRec(bmsId, bm, bms, btnEl) {
  const alreadyLiked = likedBmsIds.has(bmsId);
  try {
    if (alreadyLiked) {
      await fetch(`/api/feedback/like/${bmsId}`, { method: 'DELETE' });
      likedBmsIds.delete(bmsId);
      if (btnEl) {
        btnEl.textContent = '♡ Interested';
        btnEl.classList.remove('btn-liked');
      }
      toast('Removed from liked maps', 'info');
    } else {
      await fetch('/api/feedback/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beatmapset_id: bmsId, beatmap_id: bm.id, bm, bms }),
      });
      likedBmsIds.add(bmsId);
      if (btnEl) {
        btnEl.textContent = '♥ Interested';
        btnEl.classList.add('btn-liked');
      }
      toast('Added to liked maps — recs will adapt', 'ok');
    }
  } catch (e) {
    toast('Could not update liked maps', 'err');
  }
}

function likeRecById(bmsId, el) {
  // Find the rec data from currentRecs
  const rec = currentRecs.find(r => (r.beatmapset || {}).id === bmsId);
  if (!rec) return;
  const card = el?.closest('.rec-card');
  const btn  = card?.querySelector('.btn-like');
  likeRec(bmsId, rec.beatmap || {}, rec.beatmapset || {}, btn);
}

// ─── Mini Player ─────────────────────────────
let _audioEl      = null;
let _playingBmsId = null;
let _seekDragging = false;

function _getMapMeta(bmsId) {
  // Look up title/artist/cover from currentRecs then topPlays
  const fromRecs = currentRecs.find(r => (r.beatmapset || {}).id === bmsId);
  if (fromRecs) {
    const bms = fromRecs.beatmapset || {};
    const covers = bms.covers || {};
    return {
      title:  bms.title  || '?',
      artist: bms.artist || '',
      cover:  covers['cover@2x'] || covers['cover'] ||
              `https://assets.ppy.sh/beatmaps/${bmsId}/covers/cover.jpg`,
    };
  }
  const fromPlays = topPlays.find(p => {
    const bm = p.beatmap || {};
    return (bm.beatmapset_id || (p.beatmapset || {}).id) === bmsId;
  });
  if (fromPlays) {
    const bms = fromPlays.beatmapset || {};
    return {
      title:  bms.title  || '?',
      artist: bms.artist || '',
      cover:  `https://assets.ppy.sh/beatmaps/${bmsId}/covers/cover.jpg`,
    };
  }
  return { title: 'Preview', artist: '', cover: '' };
}

function _showPlayerBar(bmsId) {
  const meta = _getMapMeta(bmsId);
  document.getElementById('player-cover').src     = meta.cover;
  document.getElementById('player-title').textContent  = meta.title;
  document.getElementById('player-artist').textContent = meta.artist;
  document.getElementById('player-bar').classList.remove('hidden');
  document.body.classList.add('player-active');
  _updatePlayerButton(true);
  document.getElementById('player-seek').value = 0;
  document.getElementById('player-time').textContent = '0:00';
}

function _hidePlayerBar() {
  document.getElementById('player-bar').classList.add('hidden');
  document.body.classList.remove('player-active');
}

function _updatePlayerButton(playing) {
  const btn = document.getElementById('player-playpause');
  if (!btn) return;
  btn.innerHTML = playing
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
}

function _fmtSecs(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function togglePreview(bmsId, btnEl) {
  const previewUrl = `https://b.ppy.sh/preview/${bmsId}.mp3`;

  if (_playingBmsId === bmsId && _audioEl) {
    if (_audioEl.paused) {
      _audioEl.play();
      _updatePlayerButton(true);
      document.querySelectorAll('.btn-preview').forEach(b => b.classList.remove('playing'));
      if (btnEl) btnEl.classList.add('playing');
    } else {
      _audioEl.pause();
      _updatePlayerButton(false);
      if (btnEl) btnEl.classList.remove('playing');
    }
    return;
  }

  // Stop previous
  if (_audioEl) { _audioEl.pause(); _audioEl = null; }
  document.querySelectorAll('.btn-preview').forEach(b => b.classList.remove('playing'));

  _audioEl = new Audio(previewUrl);
  _audioEl.volume = (document.getElementById('player-volume')?.value ?? 50) / 100;
  _playingBmsId   = bmsId;
  if (btnEl) btnEl.classList.add('playing');

  _audioEl.addEventListener('timeupdate', () => {
    if (_seekDragging || !_audioEl) return;
    const dur  = _audioEl.duration || 30;
    const pct  = (_audioEl.currentTime / dur) * 100;
    const seek = document.getElementById('player-seek');
    const time = document.getElementById('player-time');
    if (seek) seek.value = pct;
    if (time) time.textContent = _fmtSecs(_audioEl.currentTime);
  });

  _audioEl.addEventListener('loadedmetadata', () => {
    const dur = document.getElementById('player-duration');
    if (dur && _audioEl) dur.textContent = _fmtSecs(_audioEl.duration);
  });

  _audioEl.addEventListener('ended', () => {
    _updatePlayerButton(false);
    document.querySelectorAll('.btn-preview').forEach(b => b.classList.remove('playing'));
    const seek = document.getElementById('player-seek');
    if (seek) seek.value = 0;
    const time = document.getElementById('player-time');
    if (time) time.textContent = '0:00';
    _playingBmsId = null;
  });

  _showPlayerBar(bmsId);
  _audioEl.play().catch(() => {
    toast('Preview unavailable', 'info');
    _hidePlayerBar();
    if (btnEl) btnEl.classList.remove('playing');
    _playingBmsId = null;
  });
}

function playerToggle() {
  if (!_audioEl) return;
  if (_audioEl.paused) {
    _audioEl.play();
    _updatePlayerButton(true);
    document.querySelectorAll(`[data-bmsid="${_playingBmsId}"] .btn-preview`).forEach(b => b.classList.add('playing'));
  } else {
    _audioEl.pause();
    _updatePlayerButton(false);
    document.querySelectorAll('.btn-preview').forEach(b => b.classList.remove('playing'));
  }
}

function playerStop() {
  if (_audioEl) { _audioEl.pause(); _audioEl = null; }
  document.querySelectorAll('.btn-preview').forEach(b => b.classList.remove('playing'));
  _playingBmsId = null;
  _hidePlayerBar();
}

function playerSeek(pct) {
  if (!_audioEl) return;
  const dur = _audioEl.duration || 30;
  _audioEl.currentTime = (pct / 100) * dur;
  const time = document.getElementById('player-time');
  if (time) time.textContent = _fmtSecs(_audioEl.currentTime);
}

function playerVolume(val) {
  if (_audioEl) _audioEl.volume = val / 100;
  const icon = document.getElementById('player-vol-icon');
  if (!icon) return;
  const v = parseInt(val);
  if (v === 0) {
    icon.innerHTML = `<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>`;
  } else if (v < 50) {
    icon.innerHTML = `<path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>`;
  } else {
    icon.innerHTML = `<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>`;
  }
}

// Seek drag state
document.addEventListener('mousedown', e => { if (e.target.id === 'player-seek') _seekDragging = true; });
document.addEventListener('mouseup',   () => { _seekDragging = false; });

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

  // Suggested mod badges
  const suggestedMods = Array.isArray(rec.suggested_mods) ? rec.suggested_mods : [];
  const modBadges = suggestedMods.length
    ? `<div class="rec-mods">${suggestedMods.map(m =>
        `<span class="rec-mod-badge mod-${m}">${m}</span>`).join('')}</div>`
    : '';

  // Category label
  const catLabels = { best_match:'Best Match', pp_farm:'PP Farm', comfort:'Comfort',
                      challenge:'Challenge', just_ranked:'Just Ranked' };
  const catLabel = catLabels[rec.category] || '';
  const catBadge = catLabel
    ? `<span class="cat-badge cat-${rec.category}">${catLabel}</span>` : '';

  return `<div class="rec-card" data-bmsid="${bmsId}">
  <div class="rec-cover">
    <img src="${cover}" alt="" loading="lazy" onerror="this.style.opacity=0">
    <div class="rec-cover-overlay"></div>
    <div class="rec-source-badge">${source}</div>
    <div class="rec-stars ${starClass}">★ ${sr}</div>
  </div>
  <div class="rec-body">
    <div class="rec-title-row">
      <div class="rec-title">${esc(bms.title || '?')} <span class="rec-version">— ${esc(bm.version || '?')}</span></div>
      ${catBadge}
    </div>
    <div class="rec-mapper">${esc(bms.artist || '')} · mapped by ${esc(bms.creator || '?')}</div>
    <div class="rec-attrs">
      ${ar     ? `<span class="attr-chip ar">${ar}</span>` : ''}
      ${od     ? `<span class="attr-chip">${od}</span>` : ''}
      ${bpmStr ? `<span class="attr-chip bpm">${bpmStr}</span>` : ''}
      ${length ? `<span class="attr-chip">${length}</span>` : ''}
    </div>
    ${modBadges}
    ${renderTypeBadges(bm.map_types)}
    ${rec.reason ? `<div class="rec-reason">💡 ${esc(rec.reason)}</div>` : ''}
  </div>
  <div class="rec-actions">
    <button class="btn-preview" onclick="togglePreview(${bmsId}, this)" title="Preview audio">▶</button>
    <a href="${viewUrl}" target="_blank" class="btn-outline">View</a>
    <a href="${dlUrl}" target="_blank" class="btn-outline btn-dl">Download</a>
    <a href="osu://b/${bmId}" class="btn-outline" title="Open in osu!">▶ Play</a>
    <button class="btn-like${likedBmsIds.has(bmsId) ? ' btn-liked' : ''}" onclick="likeRecById(${bmsId}, this)" title="Mark as interested">${likedBmsIds.has(bmsId) ? '♥ Interested' : '♡ Interested'}</button>
    <button class="btn-dismiss" onclick="dismissRecById(${bmsId}, this)" title="Not interested">✕ Not interested</button>
    <button class="btn-dismiss" onclick="blockMapper(${JSON.stringify(bms.creator || '')}, this)" title="Block all maps by this mapper">⊘ Block mapper</button>
  </div>
</div>`;
}

function dismissRecById(bmsId, el) {
  const card = el?.closest('.rec-card');
  dismissRec(bmsId, card);
}

async function blockMapper(creator, el) {
  const creatorLower = (creator || '').toLowerCase().trim();
  if (!creatorLower) return;
  try {
    await fetch('/api/blocked-mappers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creator: creatorLower }),
    });
    blockedMappers.add(creatorLower);
    // Remove all rec cards by this mapper
    currentRecs = currentRecs.filter(r => (r.beatmapset?.creator || '').toLowerCase() !== creatorLower);
    renderRecs(currentRecs);
    toast(`Blocked maps by ${creator}`, 'info');
  } catch (e) {
    toast('Could not block mapper', 'err');
  }
}

// ─── Recommendation history ──────────────────
async function loadHistory() {
  const el = document.getElementById('history-list');
  if (!el) return;
  try {
    const r    = await fetch('/api/history');
    const data = await r.json();
    const entries = data.history || [];
    if (!entries.length) {
      el.innerHTML = `<p style="font-size:.82rem;color:var(--text-muted)">No sessions yet — load recommendations to start tracking.</p>`;
      return;
    }
    el.innerHTML = entries.map(e => {
      const date = new Date(e.timestamp).toLocaleString();
      const mods = (e.mod_filter || []).length ? ` · ${e.mod_filter.join('+')}` : '';
      const maps = (e.maps || []).map(m =>
        `<span class="history-map-chip" title="${esc(m.creator || '')}">${esc(m.title || '?')} <span class="history-sr">${m.sr ? parseFloat(m.sr).toFixed(1) + '★' : ''}</span></span>`
      ).join('');
      return `<div class="history-entry">
        <div class="history-meta">${date}${mods} · ${e.count} maps</div>
        <div class="history-maps">${maps}</div>
      </div>`;
    }).join('');
  } catch (_) {
    document.getElementById('history-list').innerHTML = `<p style="font-size:.82rem;color:var(--red)">Could not load history.</p>`;
  }
}

// ─── Explore tab ────────────────────────────
async function loadExploreRecs() {
  const sr  = parseFloat(document.getElementById('explore-sr').value)  || 5.0;
  const ar  = parseFloat(document.getElementById('explore-ar').value)  || 9.0;
  const bpm = parseFloat(document.getElementById('explore-bpm').value) || 180;
  const loading = document.getElementById('explore-loading');
  const errEl   = document.getElementById('explore-error');
  const grid    = document.getElementById('explore-grid');
  loading?.classList.remove('hidden');
  errEl?.classList.add('hidden');
  grid?.classList.add('hidden');
  try {
    const params = new URLSearchParams({ sr, ar, bpm });
    const r    = await fetch(`/api/recommendations/explore?${params}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    loading?.classList.add('hidden');
    const recs = data.recommendations || [];
    if (!recs.length) {
      grid.classList.remove('hidden');
      grid.innerHTML = `<div class="loading-state"><div class="error-icon">🔍</div><p>No maps found — try adjusting the values.</p></div>`;
      return;
    }
    grid.innerHTML = recs.map(buildRecCard).join('');
    grid?.classList.remove('hidden');
  } catch (e) {
    loading?.classList.add('hidden');
    document.getElementById('explore-error-msg').textContent = e.message;
    errEl?.classList.remove('hidden');
  }
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
  // Desktop header tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  // Mobile bottom nav tabs
  document.querySelectorAll('.mobile-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}
function switchTab(name) {
  // Desktop header tabs — update active + ARIA
  document.querySelectorAll('.tab').forEach(t => {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  // Mobile bottom nav tabs
  document.querySelectorAll('.mobile-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  // Tab panels
  document.querySelectorAll('.tab-content').forEach(s => s.classList.toggle('active', s.id === `tab-${name}`));
  // Lazy-load the liked tab on first visit
  if (name === 'liked' && !likedTabLoaded) loadLikedTab();
  // Lazy-load history when opening settings
  if (name === 'settings') loadHistory();
  // Player continues across tabs — no stop on tab switch
}

// ─── Toast ───────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ─── Map type badges ─────────────────────────
function renderTypeBadges(types) {
  if (!types || !types.length) return '';
  return `<div class="map-types">${types.map(t => {
    const cls = 'type-' + t.replace(/\s+/g, '-');
    return `<span class="type-badge ${cls}">${esc(t)}</span>`;
  }).join('')}</div>`;
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

// ─── Export functions ────────────────────────
function exportRecs() {
  if (!currentRecs.length) { toast('No recommendations to export', 'info'); return; }
  const lines = currentRecs.map(r => {
    const bms = r.beatmapset || {}, bm = r.beatmap || {};
    return `osu://b/${bm.id}  # ${bms.artist || ''} - ${bms.title || ''} [${bm.version || ''}] by ${bms.creator || ''} (${bm.difficulty_rating || '?'}★)`;
  });
  _downloadText('osu-recommendations.txt', lines.join('\n'));
  toast('Recommendations exported', 'ok');
}

async function exportLiked() {
  try {
    const r = await fetch('/api/feedback');
    const data = await r.json();
    const entries = data.entries || [];
    if (!entries.length) { toast('No liked maps to export', 'info'); return; }
    const lines = entries.map(e => {
      const title = e.title || e.bms_id;
      return `osu://s/${e.bms_id}  # ${title}`;
    });
    _downloadText('osu-liked-maps.txt', lines.join('\n'));
    toast('Liked maps exported', 'ok');
  } catch (_) { toast('Could not export liked maps', 'err'); }
}

function _downloadText(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Liked Maps Tab ──────────────────────────
let likedTabLoaded = false;
let _radarChart    = null;
let _driftChart    = null;

async function loadLikedTab() {
  likedTabLoaded = true;
  const grid    = document.getElementById('liked-grid');
  const empty   = document.getElementById('liked-empty');
  const loading = document.getElementById('liked-loading');
  const profile = document.getElementById('taste-profile-card');
  loading?.classList.remove('hidden');
  grid?.classList.add('hidden');
  empty?.classList.add('hidden');
  profile?.classList.add('hidden');

  try {
    const [feedResp, statsResp, snapResp] = await Promise.all([
      fetch('/api/feedback'),
      fetch('/api/profile-stats'),
      fetch('/api/taste-snapshots'),
    ]);
    const feedData  = await feedResp.json();
    const statsData = statsResp.ok ? await statsResp.json() : null;
    const snapData  = snapResp.ok  ? await snapResp.json() : null;

    const entries = feedData.entries || [];
    loading?.classList.add('hidden');

    // Render liked map cards
    if (!entries.length) {
      empty?.classList.remove('hidden');
    } else {
      grid.innerHTML = entries.map(buildLikedCard).join('');
      grid?.classList.remove('hidden');
      document.getElementById('liked-subtitle').textContent =
        `${entries.length} liked map${entries.length !== 1 ? 's' : ''} shaping your recommendations`;
    }

    // Render taste profile radar
    if (statsData && !statsData.error) {
      renderTasteProfile(statsData);
      profile?.classList.remove('hidden');
    }

    // Render drift chart
    const snapshots = snapData?.snapshots || [];
    if (snapshots.length >= 2) {
      renderDriftChart(snapshots);
      document.getElementById('drift-chart-card')?.classList.remove('hidden');
    }
  } catch (e) {
    loading?.classList.add('hidden');
    toast('Could not load liked maps', 'err');
  }
}

function buildLikedCard(entry) {
  const bmsId = entry.bms_id || 0;
  const title = esc(entry.title || `Map #${bmsId}`);
  const artist = esc(entry.artist || '');
  const creator = esc(entry.creator || '');
  const sr = entry.sr ? parseFloat(entry.sr).toFixed(2) : '?';
  const ar = entry.ar ? `AR${parseFloat(entry.ar).toFixed(1)}` : '';
  const bpm = entry.bpm ? `${Math.round(entry.bpm)}BPM` : '';
  const types = entry.map_types || [];
  const likedAt = entry.liked_at ? new Date(entry.liked_at).toLocaleDateString() : '';

  return `<div class="rec-card liked-card" data-bmsid="${bmsId}">
  <div class="rec-body" style="padding:0.8rem 0.95rem">
    <div class="rec-title-row">
      <div class="rec-title">${title}</div>
      <span class="liked-date">${likedAt}</span>
    </div>
    <div class="rec-mapper">${artist}${artist && creator ? ' · ' : ''}${creator ? 'mapped by ' + creator : ''}</div>
    <div class="rec-attrs">
      ${sr !== '?' ? `<span class="attr-chip">★ ${sr}</span>` : ''}
      ${ar ? `<span class="attr-chip ar">${ar}</span>` : ''}
      ${bpm ? `<span class="attr-chip bpm">${bpm}</span>` : ''}
    </div>
    ${renderTypeBadges(types)}
  </div>
  <div class="rec-actions">
    <a href="https://osu.ppy.sh/s/${bmsId}" target="_blank" rel="noopener" class="btn-outline">View</a>
    <button class="btn-dismiss" onclick="unlikeFromTab(${bmsId}, this)" title="Remove from liked">✕ Unlike</button>
  </div>
</div>`;
}

async function unlikeFromTab(bmsId, el) {
  try {
    await fetch(`/api/feedback/like/${bmsId}`, { method: 'DELETE' });
    likedBmsIds.delete(bmsId);
    const card = el?.closest('.rec-card');
    if (card) { card.classList.add('dismissing'); setTimeout(() => card.remove(), 300); }
    toast('Removed from liked maps', 'info');
    // Refresh the liked-bms tracking in the recs tab
    renderRecs(currentRecs);
  } catch (_) { toast('Could not unlike map', 'err'); }
}

// ─── Taste Radar Chart ───────────────────────
function renderTasteProfile(stats) {
  const axes        = stats.axes || [];
  const typeWeights = stats.type_weights || {};
  const skillGap    = stats.skill_gap;

  // Radar chart
  const labels = axes.map(a => a.label);
  const values = axes.map(a => Math.min((a.value / a.max) * 100, 100));
  const ctx    = document.getElementById('taste-radar');
  if (!ctx) return;

  if (_radarChart) { _radarChart.destroy(); _radarChart = null; }
  _radarChart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels,
      datasets: [{
        label: 'Your Profile',
        data: values,
        backgroundColor: 'rgba(255,102,170,0.15)',
        borderColor:     'rgba(255,102,170,0.85)',
        pointBackgroundColor: 'rgba(255,102,170,1)',
        pointRadius: 4,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: false,
      plugins: { legend: { display: false } },
      scales: {
        r: {
          min: 0, max: 100,
          ticks: { display: false, stepSize: 25 },
          grid:        { color: 'rgba(255,255,255,0.08)' },
          angleLines:  { color: 'rgba(255,255,255,0.08)' },
          pointLabels: { color: '#ccc', font: { size: 11, family: "'DM Sans', sans-serif" } },
        },
      },
    },
  });

  // Map-type chips
  const chipEl = document.getElementById('taste-type-chips');
  if (chipEl) {
    const sorted = Object.entries(typeWeights).sort((a, b) => b[1] - a[1]);
    chipEl.innerHTML = sorted.map(([t, w]) => {
      const pct = Math.round(w * 100);
      if (pct < 5) return '';
      const cls = 'type-' + t.replace(/\s+/g, '-');
      return `<span class="type-badge ${cls}" title="${pct}% of your plays">${esc(t)} ${pct}%</span>`;
    }).join('');
  }

  // Skill gap banner
  const gapEl = document.getElementById('skill-gap-badge');
  if (gapEl) {
    if (skillGap) {
      gapEl.textContent = `💡 Skill gap: ${skillGap}`;
      gapEl.classList.remove('hidden');
    } else {
      gapEl.classList.add('hidden');
    }
  }
}

function renderDriftChart(snapshots) {
  const ctx = document.getElementById('drift-chart');
  if (!ctx) return;
  if (_driftChart) { _driftChart.destroy(); _driftChart = null; }

  const labels = snapshots.map(s => s.date);
  const srData  = snapshots.map(s => s.sr);
  const arData  = snapshots.map(s => s.ar);
  const bpmData = snapshots.map(s => parseFloat((s.bpm / 10).toFixed(1)));

  _driftChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Star Rating',
          data: srData,
          borderColor: 'rgba(255,102,170,0.9)',
          backgroundColor: 'rgba(255,102,170,0.08)',
          pointRadius: 3,
          borderWidth: 2,
          tension: 0.35,
          fill: false,
        },
        {
          label: 'AR',
          data: arData,
          borderColor: 'rgba(139,233,253,0.9)',
          backgroundColor: 'rgba(139,233,253,0.08)',
          pointRadius: 3,
          borderWidth: 2,
          tension: 0.35,
          fill: false,
        },
        {
          label: 'BPM÷10',
          data: bpmData,
          borderColor: 'rgba(255,184,108,0.9)',
          backgroundColor: 'rgba(255,184,108,0.08)',
          pointRadius: 3,
          borderWidth: 2,
          tension: 0.35,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#aaa', font: { size: 11 }, boxWidth: 12 },
        },
      },
      scales: {
        x: {
          ticks: { color: '#666', font: { size: 10 }, maxTicksLimit: 10 },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
        y: {
          ticks: { color: '#888', font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
      },
    },
  });
}

// Expose for inline onclick handlers
window.loadTopPlays                  = loadTopPlays;
window.loadRecommendations           = loadRecommendations;
window.loadRecsForPlay               = loadRecsForPlay;
window.switchRecMode                 = switchRecMode;
window.switchTab                     = switchTab;
window.saveSettings                  = saveSettings;
window.saveRecPrefs                  = saveRecPrefs;
window.testCredentials               = testCredentials;
window.saveActiveProfileCredentials  = saveActiveProfileCredentials;
window.toggleProfileMenu             = toggleProfileMenu;
window.switchProfile                 = switchProfile;
window.deleteProfile                 = deleteProfile;
window.openAddProfile                = openAddProfile;
window.closeAddProfile               = closeAddProfile;
window.submitAddProfile              = submitAddProfile;
window.dismissRecById                = dismissRecById;
window.blockMapper                   = blockMapper;
window.likeRecById                   = likeRecById;
window.unlikeFromTab                 = unlikeFromTab;
window.togglePreview                 = togglePreview;
window.playerToggle                  = playerToggle;
window.playerStop                    = playerStop;
window.playerSeek                    = playerSeek;
window.playerVolume                  = playerVolume;
window.exportRecs                    = exportRecs;
window.exportLiked                   = exportLiked;
window.loadLikedTab                  = loadLikedTab;
window.loadExploreRecs               = loadExploreRecs;
window.loadHistory                   = loadHistory;
window.showConfirm                   = showConfirm;
