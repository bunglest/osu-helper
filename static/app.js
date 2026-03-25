// ============================================================================
// osu! Beatmap Recommendation App - Complete JavaScript Implementation
// ============================================================================

'use strict';

// STATE VARIABLES
let topPlays = [];
let currentRecs = [];
let recMode = 'profile';
let activeCat = 'all';
let activeStatus = 'all';
let activeModFilter = '';
let sseSource = null;
let meData = null;
let allProfiles = [];
let activeProfileId = null;
let selectedMods = [];
let likedBmsIds = new Set();
let blockedMappers = new Set();
let playsViewMode = 'grid'; // 'grid' or 'list'
let recsSelectedMods = []; // mods toggled in the recs mod bar
let swipeQueue = []; // maps for the tinder swipe
let swipeHistory = []; // history of swipe decisions
let globalSrMin = null;
let globalSrMax = null;
let currentSwipeIndex = 0;
let likedTabLoaded = false;
let tasteTabLoaded = false;
let _radarChart = null;
let _driftChart = null;

const OAUTH_MODE = window.OAUTH_MODE === true;

// MOD INCOMPATIBILITY MAP
const MOD_INCOMPATIBLE = {
  'HR': ['EZ'],
  'EZ': ['HR'],
  'DT': ['HT'],
  'HT': ['DT'],
};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  checkAuthError();
  await bootstrap();
});

async function bootstrap() {
  try {
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

    await Promise.all([
      loadTopPlays(),
      loadUserInfo(),
      loadLikedIds(),
      loadBlockedMappers()
    ]);
    loadCurrentRecommendations();

    // Initialize explore sliders when tab is accessed
    setTimeout(() => {
      initDualSlider('#sr-slider', 'explore-sr-min', 'explore-sr-max', 0, 15, 0.1);
      initDualSlider('#bpm-slider', 'explore-bpm-min', 'explore-bpm-max', 60, 400, 5);
      initDualSlider('#global-sr-slider', 'global-sr-min', 'global-sr-max', 0, 20, 0.1);
    }, 100);

    setupRecsModBar();
  } catch (err) {
    console.error('Bootstrap error:', err);
  }
}

function checkAuthError() {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get('auth_error');
  if (authError) {
    toast('Auth Error: ' + authError, 'error');
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// ============================================================================
// API CALLS
// ============================================================================

async function fetchMe() {
  try {
    const r = await fetch('/api/me');
    return await r.json();
  } catch (_) { return {}; }
}

async function loadUserInfo() {
  try {
    const r = await fetch('/api/user-info');
    if (!r.ok) return;
    const data = await r.json();
    // Can update UI with user stats if needed
  } catch (_) {}
}

async function loadLikedIds() {
  try {
    const r = await fetch('/api/feedback');
    if (!r.ok) return;
    const data = await r.json();
    likedBmsIds = new Set((data.liked || []).map(Number));
  } catch (_) {}
}

async function loadBlockedMappers() {
  try {
    const r = await fetch('/api/blocked-mappers');
    if (!r.ok) return;
    const data = await r.json();
    blockedMappers = new Set((data.blocked || []).map(s => s.toLowerCase()));
  } catch (_) {}
}

// ============================================================================
// OAUTH & LOCAL MODE UI
// ============================================================================

function showOAuthLogin() {
  document.getElementById('oauth-login-screen')?.classList.remove('hidden');
}
function hideOAuthLogin() {
  document.getElementById('oauth-login-screen')?.classList.add('hidden');
}
function showOAuthUserChip(me) {
  const chip = document.getElementById('oauth-user-chip');
  if (!chip) return;
  document.getElementById('oauth-avatar').src = me.avatar_url || '';
  document.getElementById('oauth-username').textContent = me.username || '—';
  document.getElementById('oauth-pp').textContent =
    me.pp ? `${Math.round(me.pp).toLocaleString()}pp` : '—';
  chip.classList.remove('hidden');
}

function showSetupOverlay() {
  document.getElementById('setup-overlay')?.classList.remove('hidden');
}
function hideSetupOverlay() {
  document.getElementById('setup-overlay')?.classList.add('hidden');
}

document.getElementById('setup-btn')?.addEventListener('click', async () => {
  const username = document.getElementById('setup-username')?.value.trim();
  const cid = document.getElementById('setup-client-id')?.value.trim();
  const csec = document.getElementById('setup-client-secret')?.value.trim();
  const errEl = document.getElementById('setup-error');
  const btnText = document.getElementById('setup-btn-text');
  const spinner = document.getElementById('setup-spinner');

  if (!errEl || !btnText || !spinner) return;

  errEl.classList.add('hidden');
  btnText.textContent = 'Connecting…';
  spinner.classList.remove('hidden');

  const r = await fetch('/api/test-credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cid, client_secret: csec, username }),
  });
  const data = await r.json();

  if (data.ok) {
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

// ============================================================================
// PROFILES (LOCAL MODE)
// ============================================================================

async function loadProfiles() {
  if (OAUTH_MODE) return;
  try {
    const r = await fetch('/api/profiles');
    const data = await r.json();
    allProfiles = data.profiles || [];
    activeProfileId = data.active_id;
    renderProfileSwitcher();
    renderProfilesList();

    document.getElementById('profile-switcher')?.classList.remove('hidden');
    document.getElementById('profiles-card')?.classList.remove('hidden');
    document.getElementById('credentials-card')?.classList.remove('hidden');

    const active = allProfiles.find(p => p.id === activeProfileId) || {};
    const usernameField = document.getElementById('settings-username');
    const cidField = document.getElementById('settings-client-id');
    if (usernameField) usernameField.value = active.username || '';
    if (cidField) cidField.value = active.client_id || '';
  } catch (_) {
    toast('Could not load profiles', 'error');
  }
}

function renderProfileSwitcher() {
  const active = allProfiles.find(p => p.id === activeProfileId) || {};
  const avatar = document.getElementById('profile-avatar');
  const name = document.getElementById('profile-chip-name');
  const pp = document.getElementById('profile-chip-pp');

  if (avatar) avatar.src = active.avatar_url || '';
  if (name) name.textContent = active.display_name || active.username || '—';
  if (pp) pp.textContent = active.pp ? `${Math.round(active.pp).toLocaleString()}pp` : '—pp';

  const list = document.getElementById('profile-menu-list');
  if (!list) return;
  list.innerHTML = allProfiles.map(p => `
    <button class="profile-menu-item ${p.id === activeProfileId ? 'active' : ''}" data-profile-id="${p.id}">
      <img src="${esc(p.avatar_url || '')}" class="profile-menu-avatar">
      <span>${esc(p.display_name || p.username || '?')}</span>
    </button>
  `).join('');

  list.querySelectorAll('.profile-menu-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pid = btn.getAttribute('data-profile-id');
      await activateProfile(pid);
    });
  });
}

function renderProfilesList() {
  const list = document.getElementById('profiles-table');
  if (!list) return;

  list.innerHTML = allProfiles.map(p => `
    <div class="profile-row">
      <img src="${esc(p.avatar_url || '')}" class="profile-row-avatar">
      <div class="profile-info">
        <div class="profile-name">${esc(p.display_name || p.username || '?')}</div>
        <div class="profile-meta">${esc(p.username || '?')} • ${Math.round(p.pp || 0).toLocaleString()}pp</div>
      </div>
      <div class="profile-actions">
        <button class="btn-delete-profile" data-profile-id="${p.id}">Delete</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.btn-delete-profile').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pid = btn.getAttribute('data-profile-id');
      if (confirm('Delete this profile?')) {
        await deleteProfile(pid);
      }
    });
  });
}

async function activateProfile(pid) {
  try {
    await fetch(`/api/profiles/${pid}/activate`, { method: 'POST' });
    activeProfileId = pid;
    await loadProfiles();
    await loadTopPlays();
    await loadCurrentRecommendations();
    toast('Profile activated', 'success');
  } catch (_) {
    toast('Error activating profile', 'error');
  }
}

async function deleteProfile(pid) {
  try {
    await fetch(`/api/profiles/${pid}`, { method: 'DELETE' });
    await loadProfiles();
    toast('Profile deleted', 'success');
  } catch (_) {
    toast('Error deleting profile', 'error');
  }
}

// ============================================================================
// SETTINGS
// ============================================================================

function populateSettings(me) {
  document.getElementById('settings-top-n')?.setAttribute('value', me.top_n || 50);
  document.getElementById('settings-poll-interval')?.setAttribute('value', me.poll_interval || 60);
  document.getElementById('settings-rec-count')?.setAttribute('value', me.rec_count || 10);
  document.getElementById('settings-sr-min')?.setAttribute('value', me.sr_min || 0);
  document.getElementById('settings-sr-max')?.setAttribute('value', me.sr_max || 15);

  // Preferred mods
  const modCheckboxes = document.querySelectorAll('[data-mod-checkbox]');
  const prefMods = (me.preferred_mods || '').split(',').map(m => m.trim()).filter(m => m);
  modCheckboxes.forEach(cb => {
    const mod = cb.getAttribute('data-mod-checkbox');
    cb.checked = prefMods.includes(mod);
  });

  document.getElementById('settings-use-recent')?.setAttribute('checked', me.use_recent_plays ? '' : null);

  // Save settings button
  document.getElementById('save-settings-btn')?.addEventListener('click', saveSettings);
}

async function saveSettings() {
  const topN = parseInt(document.getElementById('settings-top-n')?.value || 50);
  const pollInterval = parseInt(document.getElementById('settings-poll-interval')?.value || 60);
  const recCount = parseInt(document.getElementById('settings-rec-count')?.value || 10);
  const srMin = parseFloat(document.getElementById('settings-sr-min')?.value || 0);
  const srMax = parseFloat(document.getElementById('settings-sr-max')?.value || 15);

  const modCheckboxes = document.querySelectorAll('[data-mod-checkbox]:checked');
  const prefMods = Array.from(modCheckboxes).map(cb => cb.getAttribute('data-mod-checkbox')).join(',');

  const useRecent = document.getElementById('settings-use-recent')?.checked || false;

  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        top_n: topN,
        poll_interval: pollInterval,
        rec_count: recCount,
        sr_min: srMin,
        sr_max: srMax,
        preferred_mods: prefMods,
        use_recent_plays: useRecent,
      }),
    });
    toast('Settings saved', 'success');
  } catch (err) {
    console.error('Error saving settings:', err);
    toast('Failed to save settings', 'error');
  }
}

// ============================================================================
// TAB NAVIGATION
// ============================================================================

function setupTabs() {
  // Desktop header tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  // Mobile bottom nav tabs
  document.querySelectorAll('.mobile-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  // View toggle (grid/list) for top plays
  document.querySelectorAll('.view-toggle .view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      playsViewMode = btn.dataset.view;
      toggleViewMode();
    });
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
  document.querySelectorAll('.tab-content').forEach(s =>
    s.classList.toggle('active', s.id === `tab-${name}`)
  );

  // Lazy-load tabs on first visit
  if (name === 'liked' && !likedTabLoaded) loadLikedTab();
  if (name === 'taste' && !tasteTabLoaded) loadTasteTab();
  if (name === 'settings') loadHistory();
}

// ============================================================================
// TOP PLAYS TAB
// ============================================================================

async function loadTopPlays() {
  document.getElementById('plays-loading')?.classList.remove('hidden');
  document.getElementById('plays-error')?.classList.add('hidden');
  document.getElementById('plays-empty')?.classList.add('hidden');
  document.getElementById('plays-grid')?.classList.add('hidden');
  try {
    const resp = await fetch('/api/top-plays');
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    topPlays = data.plays || [];
    renderTopPlays();
  } catch (err) {
    document.getElementById('plays-loading')?.classList.add('hidden');
    document.getElementById('plays-error')?.classList.remove('hidden');
    document.getElementById('plays-error-msg').textContent = err.message;
  }
}

document.getElementById('refresh-plays-btn')?.addEventListener('click', loadTopPlays);

function renderTopPlays() {
  const loading = document.getElementById('plays-loading');
  const error   = document.getElementById('plays-error');
  const empty   = document.getElementById('plays-empty');
  const grid    = document.getElementById('plays-grid');
  loading?.classList.add('hidden');
  error?.classList.add('hidden');

  if (!topPlays.length) {
    empty?.classList.remove('hidden');
    grid?.classList.add('hidden');
    return;
  }
  empty?.classList.add('hidden');
  grid?.classList.remove('hidden');
  grid.classList.toggle('list-view', playsViewMode === 'list');
  grid.innerHTML = topPlays.map((play, idx) => buildPlayCard(play, idx)).join('');
  document.getElementById('plays-subtitle').textContent = `Showing ${topPlays.length} best scores`;

  // Attach event listeners
  grid.querySelectorAll('[data-play-btn]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const bmsId = parseInt(btn.getAttribute('data-play-btn'));
      togglePreview(bmsId, btn);
    });
  });

  grid.querySelectorAll('[data-view-btn]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const bmId = btn.getAttribute('data-view-btn');
      window.open(`https://osu.ppy.sh/b/${bmId}`, '_blank');
    });
  });

  grid.querySelectorAll('[data-similar-btn]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.getAttribute('data-similar-btn'));
      loadRecsForPlay(idx);
    });
  });
}

function buildPlayCard(play, index) {
  const bm = play.beatmap || {};
  const srClass = starColorClass(bm.difficulty_rating || 0);
  const rankClass = `rank-${play.rank?.toUpperCase() || 'u'}`;
  const coverUrl = bm.beatmapset_id
    ? `https://assets.ppy.sh/beatmaps/${bm.beatmapset_id}/covers/cover.jpg`
    : '/static/placeholder.jpg';

  const modsHtml = (play.mods || []).map(m => `<span class="mod-chip">${esc(m)}</span>`).join('');

  if (playsViewMode === 'list') {
    return `
      <div class="play-card list-view">
        <div class="card-header">
          <img src="${esc(coverUrl)}" alt="Cover" class="card-cover">
          <div class="card-info">
            <div class="title">${esc(bm.title || 'Unknown')}</div>
            <div class="artist">${esc(bm.artist || 'Unknown')}</div>
            <div class="mapper">by ${esc(bm.creator || 'Unknown')}</div>
          </div>
        </div>
        <div class="card-stats">
          <span class="stat">Acc: <strong>${(play.accuracy * 100).toFixed(2)}%</strong></span>
          <span class="stat ${rankClass}">Rank: ${play.rank}</span>
          <span class="stat">PP: <strong>${Math.round(play.pp)}</strong></span>
          <span class="stat">SR: <span class="star ${srClass}">${(bm.difficulty_rating || 0).toFixed(2)}</span></span>
          <span class="stat">BPM: ${bm.bpm || 0}</span>
        </div>
        ${modsHtml ? `<div class="mods">${modsHtml}</div>` : ''}
        <div class="card-actions">
          <button class="play-btn" data-play-btn="${bm.id}" title="Preview">▶ Play</button>
          <button class="view-btn" data-view-btn="${bm.id}" title="View on osu!">View</button>
          <button class="similar-btn" data-similar-btn="${index}" title="Find similar">Similar</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="play-card">
      <img src="${esc(coverUrl)}" alt="Cover" class="card-cover">
      <div class="card-overlay">
        <button class="play-btn" data-play-btn="${bm.id}">▶</button>
      </div>
      <div class="card-content">
        <div class="title">${esc(bm.title || 'Unknown')}</div>
        <div class="artist">${esc(bm.artist || 'Unknown')}</div>
        <div class="mapper">${esc(bm.creator || 'Unknown')}</div>
        <div class="stats">
          <span class="stat">Acc: <strong>${(play.accuracy * 100).toFixed(2)}%</strong></span>
          <span class="stat ${rankClass}">Rank: ${play.rank}</span>
          <span class="stat">PP: <strong>${Math.round(play.pp)}</strong></span>
        </div>
        <div class="difficulty">
          <span class="sr ${srClass}">${(bm.difficulty_rating || 0).toFixed(2)}★</span>
          <span class="bpm">${bm.bpm || 0} BPM</span>
        </div>
        ${modsHtml ? `<div class="mods">${modsHtml}</div>` : ''}
        <div class="actions">
          <button class="view-btn" data-view-btn="${bm.id}" title="View">View</button>
          <button class="similar-btn" data-similar-btn="${index}" title="Find similar">Similar</button>
        </div>
      </div>
    </div>
  `;
}

function toggleViewMode() {
  const grid = document.getElementById('plays-grid');
  if (grid) {
    grid.classList.toggle('list-view', playsViewMode === 'list');
  }
  // Update button active states
  document.querySelectorAll('.view-toggle .view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === playsViewMode);
  });
  renderTopPlays();
}

// ============================================================================
// RECOMMENDATIONS TAB
// ============================================================================

async function loadCurrentRecommendations() {
  recMode = 'profile';
  const modLabel = activeModFilter ? ` · ${activeModFilter} plays only` : '';
  const titleEl = document.getElementById('recs-title');
  const subEl = document.getElementById('recs-subtitle');
  if (titleEl) titleEl.textContent = 'Recommendations';
  if (subEl) subEl.textContent = `Based on your overall taste profile${modLabel}`;
  document.getElementById('recs-profile-btn')?.classList.add('active-mode');

  document.getElementById('recs-loading')?.classList.remove('hidden');
  document.getElementById('recs-error')?.classList.add('hidden');
  document.getElementById('recs-grid')?.classList.add('hidden');
  document.getElementById('recs-empty-cat')?.classList.add('hidden');

  try {
    let url = '/api/recommendations';
    if (recsSelectedMods.length > 0) {
      url += '?mod_filter=' + encodeURIComponent(recsSelectedMods.join(','));
    } else if (activeModFilter) {
      url += '?mod_filter=' + encodeURIComponent(activeModFilter);
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Failed to load');
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    currentRecs = data.recommendations || [];
    renderRecommendations();
  } catch (err) {
    document.getElementById('recs-loading')?.classList.add('hidden');
    document.getElementById('recs-error')?.classList.remove('hidden');
    document.getElementById('recs-error-msg').textContent = err.message;
  }
}

// Alias for HTML onclick references
const loadRecommendations = loadCurrentRecommendations;

function renderRecommendations() {
  document.getElementById('recs-loading')?.classList.add('hidden');
  document.getElementById('recs-error')?.classList.add('hidden');
  const emptyCat = document.getElementById('recs-empty-cat');
  const grid = document.getElementById('recs-grid');

  let filtered = activeCat === 'all'
    ? currentRecs
    : currentRecs.filter(r => {
        // Match by category or mapper tags
        const cat = r.category || 'best_match';
        const types = (r.beatmap?.map_types || []).map(t => t.toLowerCase());
        return cat === activeCat || types.includes(activeCat);
      });

  if (activeStatus !== 'all') {
    filtered = filtered.filter(r => {
      const s = (r.beatmapset?.status || '').toLowerCase();
      if (activeStatus === 'ranked') return s === 'ranked' || s === 'approved';
      if (activeStatus === 'loved') return s === 'loved';
      return true;
    });
  }

  // Apply global SR filter
  if (globalSrMin !== null) {
    filtered = filtered.filter(r => (r.beatmap?.difficulty_rating || 0) >= globalSrMin);
  }
  if (globalSrMax !== null) {
    filtered = filtered.filter(r => (r.beatmap?.difficulty_rating || 0) <= globalSrMax);
  }

  if (!currentRecs.length) {
    grid?.classList.remove('hidden');
    emptyCat?.classList.add('hidden');
    grid.innerHTML = `<div class="loading-state"><div class="error-icon">🔍</div><p>No recommendations found — try refreshing.</p></div>`;
    return;
  }
  if (!filtered.length) {
    grid?.classList.add('hidden');
    if (emptyCat) { emptyCat.classList.remove('hidden'); emptyCat.textContent = 'No recommendations in this category yet.'; }
    return;
  }
  emptyCat?.classList.add('hidden');
  grid?.classList.remove('hidden');
  grid.innerHTML = filtered.map(buildRecCard).join('');
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
  const ar    = bm.ar    ? parseFloat(bm.ar).toFixed(1) : '';
  const od    = bm.accuracy ? parseFloat(bm.accuracy).toFixed(1) : '';
  const bpm   = bm.bpm || bms.bpm;
  const bpmStr = bpm ? `${Math.round(bpm)}` : '';
  const length = bm.total_length ? fmtLen(bm.total_length) : '';
  const starClass = starColorClass(parseFloat(sr));
  const dlUrl  = `https://api.nerinyan.moe/d/${bmsId}`;
  const viewUrl = bm.url || `https://osu.ppy.sh/b/${bmId}`;

  // Modified stats when mods active
  let arDisplay = ar ? `AR${ar}` : '';
  let bpmDisplay = bpmStr ? `${bpmStr}BPM` : '';
  if (recsSelectedMods.length > 0) {
    const modified = calcModifiedStats(bm, recsSelectedMods);
    if (ar) arDisplay = `AR<s>${ar}</s>→${modified.ar}`;
    if (bpmStr) bpmDisplay = `<s>${bpmStr}</s>→${modified.bpm}BPM`;
  }

  // Suggested mod badges
  const suggestedMods = Array.isArray(rec.suggested_mods) ? rec.suggested_mods : [];
  const modBadges = suggestedMods.length
    ? `<div class="rec-mods">${suggestedMods.map(m =>
        `<span class="rec-mod-badge mod-${m}">${m}</span>`).join('')}</div>`
    : '';

  // Category label
  const catLabels = { best_match:'Best Match', pp_farm:'PP Farm', comfort:'Comfort',
                      challenge:'Challenge', just_ranked:'Just Ranked', skill_gap:'Skill Gap' };
  const catLabel = catLabels[rec.category] || '';
  const catBadge = catLabel
    ? `<span class="cat-badge cat-${rec.category}">${catLabel}</span>` : '';

  return `<div class="rec-card" data-bmsid="${bmsId}">
  <div class="rec-cover">
    <img src="${cover}" alt="" loading="lazy" onerror="this.style.opacity=0">
    <div class="rec-cover-overlay"></div>
    <button class="btn-preview rec-preview-btn" onclick="togglePreview(${bmsId}, this)" title="Preview audio">▶</button>
    <div class="rec-stars ${starClass}">★ ${sr}</div>
  </div>
  <div class="rec-body">
    <div class="rec-title-row">
      <div class="rec-title">${esc(bms.title || '?')} <span class="rec-version">— ${esc(bm.version || '?')}</span></div>
      ${catBadge}
    </div>
    <div class="rec-mapper">${esc(bms.artist || '')} · mapped by ${esc(bms.creator || '?')}</div>
    <div class="rec-attrs">
      ${arDisplay ? `<span class="attr-chip ar">${arDisplay}</span>` : ''}
      ${od ? `<span class="attr-chip">OD${od}</span>` : ''}
      ${bpmDisplay ? `<span class="attr-chip bpm">${bpmDisplay}</span>` : ''}
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
    <button class="btn-like${likedBmsIds.has(bmsId) ? ' btn-liked' : ''}" onclick="likeRecById(${bmsId}, this)" title="Mark as interested">${likedBmsIds.has(bmsId) ? '♥' : '♡'}</button>
    <button class="btn-dismiss" onclick="dismissRecById(${bmsId}, this)" title="Not interested">✕</button>
  </div>
</div>`;
}

function dismissRecById(bmsId, el) {
  const card = el?.closest('.rec-card');
  dismissRec(bmsId, card);
}

function likeRecById(bmsId, el) {
  const rec = currentRecs.find(r => (r.beatmapset || {}).id === bmsId);
  if (!rec) return;
  const card = el?.closest('.rec-card');
  const btn  = card?.querySelector('.btn-like');
  likeRec(bmsId, rec.beatmap || {}, rec.beatmapset || {}, btn);
}

// Wire rec mod bar clicks
document.addEventListener('click', e => {
  const btn = e.target.closest('.rec-mod-toggle');
  if (!btn) return;
  const mod = btn.dataset.mod;
  if (recsSelectedMods.includes(mod)) {
    recsSelectedMods = recsSelectedMods.filter(m => m !== mod);
  } else {
    const incompatible = MOD_INCOMPATIBLE[mod] || [];
    recsSelectedMods = recsSelectedMods.filter(m => !incompatible.includes(m));
    recsSelectedMods.push(mod);
  }
  // Update button states
  document.querySelectorAll('.rec-mod-toggle').forEach(b => {
    b.classList.toggle('active', recsSelectedMods.includes(b.dataset.mod));
    b.setAttribute('aria-pressed', recsSelectedMods.includes(b.dataset.mod));
  });
  loadCurrentRecommendations();
});

// Wire category tabs
document.addEventListener('click', e => {
  const tab = e.target.closest('.cat-tab');
  if (tab) {
    activeCat = tab.dataset.cat;
    document.querySelectorAll('.cat-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.cat === activeCat));
    renderRecommendations();
  }
  const sbtn = e.target.closest('.status-btn');
  if (sbtn) {
    activeStatus = sbtn.dataset.status;
    document.querySelectorAll('.status-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.status === activeStatus));
    renderRecommendations();
  }
});

// Refresh recs button
document.getElementById('refresh-recs-btn')?.addEventListener('click', () => {
  if (recMode === 'profile') loadCurrentRecommendations();
  else if (recMode.startsWith('play:')) loadRecsForPlay(parseInt(recMode.split(':')[1]));
});

function switchRecMode(mode) {
  if (mode === 'profile') loadCurrentRecommendations();
}

async function likeRec(bmsId, bm, bms, btnEl) {
  const alreadyLiked = likedBmsIds.has(bmsId);
  try {
    if (alreadyLiked) {
      await fetch(`/api/feedback/like/${bmsId}`, { method: 'DELETE' });
      likedBmsIds.delete(bmsId);
      if (btnEl) { btnEl.textContent = '♡'; btnEl.classList.remove('btn-liked'); }
      toast('Removed from liked maps', 'info');
    } else {
      await fetch('/api/feedback/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beatmapset_id: bmsId, beatmap_id: bm?.id, bm: bm || {}, bms: bms || {} }),
      });
      likedBmsIds.add(bmsId);
      if (btnEl) { btnEl.textContent = '♥'; btnEl.classList.add('btn-liked'); }
      toast('Added to liked maps — recs will adapt', 'ok');
    }
  } catch (e) {
    toast('Could not update liked maps', 'err');
  }
}

async function dismissRec(bmsId, cardEl) {
  const rec = currentRecs.find(r => (r.beatmapset || {}).id === bmsId) || {};
  try {
    await fetch('/api/dismissed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        beatmapset_id: bmsId,
        bm: rec.beatmap || {},
        bms: rec.beatmapset || {},
      }),
    });
    currentRecs = currentRecs.filter(r => (r.beatmapset || {}).id !== bmsId);
    if (cardEl) {
      cardEl.classList.add('dismissing');
      setTimeout(() => cardEl.remove(), 300);
    }
    toast('Map dismissed', 'info');
  } catch (e) {
    toast('Could not dismiss map', 'err');
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
  document.getElementById('recs-profile-btn')?.classList.remove('active-mode');
  switchTab('recs');
  document.getElementById('recs-loading')?.classList.remove('hidden');
  document.getElementById('recs-grid')?.classList.add('hidden');
  try {
    const r    = await fetch(`/api/recommendations/for-play/${index}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    currentRecs = data.recommendations || [];
    renderRecommendations();
  } catch (e) {
    document.getElementById('recs-loading')?.classList.add('hidden');
    document.getElementById('recs-error')?.classList.remove('hidden');
    document.getElementById('recs-error-msg').textContent = e.message;
  }
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
    currentRecs = currentRecs.filter(r => (r.beatmapset?.creator || '').toLowerCase() !== creatorLower);
    renderRecommendations();
    toast(`Blocked maps by ${creator}`, 'info');
  } catch (e) {
    toast('Could not block mapper', 'err');
  }
}

// ============================================================================
// EXPLORE TAB
// ============================================================================

function initExploreTab() {
  // Skill category buttons
  document.querySelectorAll('[data-skill-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-skill-cat]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadExploreRecs();
    });
  });

  // Mod buttons
  document.querySelectorAll('[data-explore-mod]').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
    });
  });

  // Dual sliders
  initDualSlider('#sr-slider', 'explore-sr-min', 'explore-sr-max', 0, 15, 0.1);
  initDualSlider('#bpm-slider', 'explore-bpm-min', 'explore-bpm-max', 60, 400, 5);

  // Load button
  document.getElementById('load-explore-btn')?.addEventListener('click', loadExploreRecs);
}

async function loadExploreRecs() {
  try {
    const srMin = parseFloat(document.getElementById('explore-sr-min')?.value || 0);
    const srMax = parseFloat(document.getElementById('explore-sr-max')?.value || 15);
    const bpmMin = parseInt(document.getElementById('explore-bpm-min')?.value || 60);
    const bpmMax = parseInt(document.getElementById('explore-bpm-max')?.value || 400);

    const sr = (srMin + srMax) / 2;
    const bpm = (bpmMin + bpmMax) / 2;
    const ar = 8; // Default AR for explore

    const resp = await fetch(`/api/recommendations/explore?sr=${sr}&ar=${ar}&bpm=${bpm}`);
    if (!resp.ok) throw new Error('Failed to load');
    const data = await resp.json();
    currentRecs = data.recommendations || [];

    const container = document.querySelector('[data-explore-recs]');
    if (container) {
      container.innerHTML = currentRecs.map(rec => buildRecCard(rec)).join('');
      attachRecCardListeners(container);
    }
  } catch (err) {
    console.error('Error loading explore recs:', err);
    toast('Failed to load explore recommendations', 'error');
  }
}

function initDualSlider(containerSelector, minInputId, maxInputId, absMin, absMax, step) {
  const container = document.querySelector(containerSelector);
  if (!container) return;

  const minInput = document.getElementById(minInputId);
  const maxInput = document.getElementById(maxInputId);
  const minThumb = container.querySelector('.thumb-min');
  const maxThumb = container.querySelector('.thumb-max');
  const range = container.querySelector('.slider-range');

  if (!minInput || !maxInput || !minThumb || !maxThumb || !range) return;

  minInput.value = absMin;
  maxInput.value = absMax;
  minInput.min = absMin;
  minInput.max = absMax;
  minInput.step = step;
  maxInput.min = absMin;
  maxInput.max = absMax;
  maxInput.step = step;

  function updateSlider() {
    const min = parseFloat(minInput.value);
    const max = parseFloat(maxInput.value);

    const minPercent = ((min - absMin) / (absMax - absMin)) * 100;
    const maxPercent = ((max - absMin) / (absMax - absMin)) * 100;

    minThumb.style.left = minPercent + '%';
    maxThumb.style.left = maxPercent + '%';
    range.style.left = minPercent + '%';
    range.style.right = (100 - maxPercent) + '%';
  }

  minInput.addEventListener('input', () => {
    const min = parseFloat(minInput.value);
    const max = parseFloat(maxInput.value);
    if (min > max) minInput.value = max;
    updateSlider();
  });

  maxInput.addEventListener('input', () => {
    const min = parseFloat(minInput.value);
    const max = parseFloat(maxInput.value);
    if (max < min) maxInput.value = min;
    updateSlider();
  });

  let isDragging = false;
  let dragTarget = null;

  minThumb.addEventListener('mousedown', () => {
    isDragging = true;
    dragTarget = 'min';
  });

  maxThumb.addEventListener('mousedown', () => {
    isDragging = true;
    dragTarget = 'max';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging || !dragTarget) return;

    const rect = container.getBoundingClientRect();
    const percent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const value = absMin + (percent / 100) * (absMax - absMin);
    const rounded = Math.round(value / step) * step;

    if (dragTarget === 'min') {
      const max = parseFloat(maxInput.value);
      if (rounded <= max) {
        minInput.value = rounded.toFixed(step < 1 ? 1 : 0);
      }
    } else {
      const min = parseFloat(minInput.value);
      if (rounded >= min) {
        maxInput.value = rounded.toFixed(step < 1 ? 1 : 0);
      }
    }
    updateSlider();
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    dragTarget = null;
  });

  updateSlider();
}

// ============================================================================
// LIKED TAB
// ============================================================================

async function loadLikedTab() {
  try {
    const resp = await fetch('/api/feedback');
    if (!resp.ok) throw new Error('Failed to load');
    const data = await resp.json();

    likedBmsIds = new Set((data.liked || []).map(Number));

    const container = document.querySelector('[data-liked-grid]');
    if (!container) return;

    const entries = data.entries || [];
    container.innerHTML = entries.map(entry => buildLikedCard(entry)).join('');
    attachLikedCardListeners(container);
  } catch (err) {
    console.error('Error loading liked tab:', err);
    toast('Failed to load liked maps', 'error');
  }
}

function buildLikedCard(entry) {
  const bm = entry.beatmap || {};
  const srClass = starColorClass(bm.difficulty_rating || 0);
  const coverUrl = bm.beatmapset_id
    ? `https://assets.ppy.sh/beatmaps/${bm.beatmapset_id}/covers/cover.jpg`
    : '/static/placeholder.jpg';

  return `
    <div class="liked-card">
      <img src="${esc(coverUrl)}" alt="Cover" class="card-cover">
      <div class="card-content">
        <div class="title">${esc(bm.title || 'Unknown')}</div>
        <div class="artist">${esc(bm.artist || 'Unknown')}</div>
        <div class="mapper">${esc(bm.creator || 'Unknown')}</div>
        <div class="stats">
          <span class="stat">SR: <span class="sr ${srClass}">${(bm.difficulty_rating || 0).toFixed(2)}</span></span>
          <span class="stat">AR: ${(bm.ar || 0).toFixed(1)}</span>
          <span class="stat">BPM: ${bm.bpm || 0}</span>
        </div>
        <div class="actions">
          <button class="play-btn" data-play-btn="${bm.id}">▶ Play</button>
          <button class="view-btn" data-view-btn="${bm.id}">View</button>
          <button class="download-btn" data-download-btn="${bm.id}">↓ Download</button>
          <button class="unlike-btn" data-unlike-btn="${bm.id}">Remove</button>
        </div>
      </div>
    </div>
  `;
}

function attachLikedCardListeners(container) {
  container.querySelectorAll('[data-play-btn]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const bmsId = btn.getAttribute('data-play-btn');
      const protocol = `osu://b/${bmsId}`;
      window.location.href = protocol;
    });
  });

  container.querySelectorAll('[data-view-btn]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const bmsId = btn.getAttribute('data-view-btn');
      window.open(`https://osu.ppy.sh/b/${bmsId}`, '_blank');
    });
  });

  container.querySelectorAll('[data-download-btn]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const bmsId = btn.getAttribute('data-download-btn');
      window.open(`https://nerinyan.moe/d/${bmsId}`, '_blank');
    });
  });

  container.querySelectorAll('[data-unlike-btn]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const bmsId = btn.getAttribute('data-unlike-btn');
      unlikeFromTab(bmsId, btn);
    });
  });
}

async function unlikeFromTab(bmsId, btn) {
  try {
    await fetch(`/api/feedback/like/${bmsId}`, { method: 'DELETE' });
    likedBmsIds.delete(bmsId);
    btn.closest('.liked-card').style.opacity = '0.5';
    toast('Removed from liked', 'success');
  } catch (err) {
    console.error('Error unliking:', err);
    toast('Failed to remove', 'error');
  }
}

// ============================================================================
// TASTE PROFILE TAB
// ============================================================================

async function loadTasteTab() {
  try {
    const [statsResp, snapshotsResp, feedbackResp] = await Promise.all([
      fetch('/api/profile-stats'),
      fetch('/api/taste-snapshots'),
      fetch('/api/feedback')
    ]);

    if (!statsResp.ok || !snapshotsResp.ok || !feedbackResp.ok) {
      throw new Error('Failed to load');
    }

    const stats = await statsResp.json();
    const snapshots = await snapshotsResp.json();
    const feedback = await feedbackResp.json();

    renderTasteProfile(stats);
    renderTasteDrift(snapshots);
    await loadSwipeQueue();

    likedBmsIds = new Set((feedback.liked || []).map(Number));

    setupTasteFeedbackModal();
  } catch (err) {
    console.error('Error loading taste tab:', err);
    toast('Failed to load taste profile', 'error');
  }
}

function renderTasteProfile(stats) {
  const container = document.querySelector('[data-taste-profile]');
  if (!container) return;

  const axes = stats.axes || [];
  const weights = stats.type_weights || {};
  const skillGap = stats.skill_gap || 'Unknown';

  const ctx = document.getElementById('tasteChart');
  if (ctx && window.Chart) {
    try {
      new Chart(ctx, {
        type: 'radar',
        data: {
          labels: axes.map(a => a.name || '?'),
          datasets: [{
            label: 'Taste Profile',
            data: axes.map(a => a.value || 0),
            borderColor: '#ff6b9d',
            backgroundColor: 'rgba(255, 107, 157, 0.2)',
            pointBackgroundColor: '#ff6b9d',
            tension: 0.2
          }]
        },
        options: {
          responsive: true,
          scales: {
            r: {
              max: 100,
              beginAtZero: true
            }
          }
        }
      });
    } catch (e) {
      console.error('Chart error:', e);
    }
  }

  let breakdownHtml = '<div class="taste-breakdown">';
  for (const [type, weight] of Object.entries(weights)) {
    breakdownHtml += `
      <div class="weight-item">
        <span class="type">${esc(type)}</span>
        <div class="bar">
          <div class="fill" style="width: ${weight * 100}%"></div>
        </div>
        <span class="value">${(weight * 100).toFixed(0)}%</span>
      </div>
    `;
  }
  breakdownHtml += '</div>';

  const gapBadge = `<div class="skill-gap-badge">Skill Gap: ${esc(skillGap)}</div>`;

  container.innerHTML = breakdownHtml + gapBadge;
}

function renderTasteDrift(snapshots) {
  const container = document.querySelector('[data-taste-drift]');
  if (!container || !snapshots.data) return;

  const data = snapshots.data || [];
  const ctx = document.getElementById('driftChart');

  if (ctx && window.Chart && data.length > 0) {
    try {
      new Chart(ctx, {
        type: 'line',
        data: {
          labels: data.map((_, i) => `Week ${i + 1}`),
          datasets: [{
            label: 'Taste Drift',
            data: data,
            borderColor: '#00d4ff',
            tension: 0.3,
            fill: false
          }]
        },
        options: {
          responsive: true,
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      });
    } catch (e) {
      console.error('Drift chart error:', e);
    }
  }
}

async function loadSwipeQueue() {
  try {
    const resp = await fetch('/api/recommendations');
    if (!resp.ok) throw new Error('Failed to load');
    const data = await resp.json();
    swipeQueue = data.recommendations || [];
    currentSwipeIndex = 0;
    showNextSwipeCard();
  } catch (err) {
    console.error('Error loading swipe queue:', err);
    toast('Failed to load swipe queue', 'error');
  }
}

function showNextSwipeCard() {
  const container = document.getElementById('swipe-container');
  if (!container) return;

  if (currentSwipeIndex >= swipeQueue.length) {
    container.innerHTML = '<div class="swipe-end">No more maps to discover! Refresh recommendations to get more.</div>';
    return;
  }

  const rec = swipeQueue[currentSwipeIndex];
  const bm = rec.beatmap || {};
  const bms = rec.beatmapset || {};
  const bmsId = bms.id || bm.beatmapset_id || 0;
  const covers = bms.covers || {};
  const coverUrl = covers['cover@2x'] || covers['cover'] ||
    `https://assets.ppy.sh/beatmaps/${bmsId}/covers/cover.jpg`;
  const sr = bm.difficulty_rating ? bm.difficulty_rating.toFixed(2) : '?';
  const srClass = starColorClass(parseFloat(sr));
  const ar = bm.ar ? `AR${parseFloat(bm.ar).toFixed(1)}` : '';
  const bpmStr = bm.bpm ? `${Math.round(bm.bpm)} BPM` : '';
  const length = bm.total_length ? fmtLen(bm.total_length) : '';

  container.innerHTML = `
    <div class="swipe-card" id="swipe-card">
      <div class="swipe-card-inner">
        <div class="swipe-cover">
          <img src="${coverUrl}" alt="" onerror="this.style.opacity=0" />
          <div class="swipe-cover-overlay"></div>
          <div class="swipe-stars ${srClass}">★ ${sr}</div>
        </div>
        <div class="swipe-body">
          <div class="swipe-title">${esc(bms.title || bm.title || 'Unknown')}</div>
          <div class="swipe-artist">${esc(bms.artist || '')} · mapped by ${esc(bms.creator || '?')}</div>
          <div class="swipe-attrs">
            ${ar ? `<span class="attr-chip ar">${ar}</span>` : ''}
            ${bpmStr ? `<span class="attr-chip bpm">${bpmStr}</span>` : ''}
            ${length ? `<span class="attr-chip">${length}</span>` : ''}
          </div>
          ${renderTypeBadges(bm.map_types)}
          ${rec.reason ? `<div class="rec-reason" style="margin-top:0.5rem">💡 ${esc(rec.reason)}</div>` : ''}
        </div>
      </div>
      <div class="swipe-indicator swipe-yes">TRY IT</div>
      <div class="swipe-indicator swipe-no">SKIP</div>
    </div>
  `;
}

function swipeAction(direction) {
  if (currentSwipeIndex >= swipeQueue.length) return;

  const rec = swipeQueue[currentSwipeIndex];
  const bm = rec.beatmap || {};
  const bms = rec.beatmapset || {};
  const bmsId = bms.id || bm.beatmapset_id || 0;
  const action = direction === 'right' ? 'approve' : 'skip';

  swipeHistory.push({
    bmsId,
    title: bms.title || bm.title || '?',
    action,
    timestamp: new Date().toISOString()
  });

  if (direction === 'right') {
    likeRec(bmsId, bm, bms, null);
  } else {
    dismissRec(bmsId, null);
  }

  const container = document.getElementById('swipe-container');
  if (container) {
    const swipeCard = container.querySelector('.swipe-card');
    if (swipeCard) {
      swipeCard.classList.add(direction === 'right' ? 'swiping-right' : 'swiping-left');
      setTimeout(() => {
        currentSwipeIndex++;
        showNextSwipeCard();
      }, 350);
    }
  }
}

function previewSwipeMap() {
  if (currentSwipeIndex >= swipeQueue.length) return;
  const rec = swipeQueue[currentSwipeIndex];
  const bms = rec.beatmapset || {};
  const bm = rec.beatmap || {};
  const bmsId = bms.id || bm.beatmapset_id || 0;
  if (bmsId) togglePreview(bmsId, null);
}

function openTasteFeedback() {
  document.getElementById('taste-feedback-modal')?.classList.remove('hidden');
}

function closeTasteFeedback() {
  document.getElementById('taste-feedback-modal')?.classList.add('hidden');
  const textarea = document.getElementById('taste-feedback-text');
  if (textarea) textarea.value = '';
}

function submitTasteFeedback() {
  const textarea = document.getElementById('taste-feedback-text');
  const feedback = textarea?.value?.trim();

  if (!feedback) {
    toast('Please enter some feedback', 'err');
    return;
  }

  // Store feedback locally (could be sent to API in future)
  toast('Thank you! Your feedback has been noted.', 'ok');
  closeTasteFeedback();
}

// ============================================================================
// SETTINGS TAB
// ============================================================================

async function loadSettingsTab() {
  try {
    await loadProfiles();
    loadSwipeHistory();
    setupSettingsEventListeners();
  } catch (err) {
    console.error('Error loading settings tab:', err);
  }
}

function setupSettingsEventListeners() {
  initDualSlider('#global-sr-slider', 'global-sr-min', 'global-sr-max', 0, 20, 0.1);

  const saveDiffBtn = document.getElementById('save-difficulty-btn');
  if (saveDiffBtn) {
    saveDiffBtn.addEventListener('click', saveGlobalDifficulty);
  }

  const clearDiffBtn = document.getElementById('clear-difficulty-btn');
  if (clearDiffBtn) {
    clearDiffBtn.addEventListener('click', clearGlobalDifficulty);
  }

  const testCredsBtn = document.getElementById('test-creds-btn');
  if (testCredsBtn) {
    testCredsBtn.addEventListener('click', testCredentials);
  }
}

function saveGlobalDifficulty() {
  const minInput = document.getElementById('global-sr-min');
  const maxInput = document.getElementById('global-sr-max');

  if (!minInput || !maxInput) return;

  globalSrMin = parseFloat(minInput.value);
  globalSrMax = parseFloat(maxInput.value);

  localStorage.setItem('globalSrMin', globalSrMin);
  localStorage.setItem('globalSrMax', globalSrMax);

  toast('Global difficulty saved', 'success');
}

function clearGlobalDifficulty() {
  globalSrMin = null;
  globalSrMax = null;

  localStorage.removeItem('globalSrMin');
  localStorage.removeItem('globalSrMax');

  const minInput = document.getElementById('global-sr-min');
  const maxInput = document.getElementById('global-sr-max');
  if (minInput) minInput.value = 0;
  if (maxInput) maxInput.value = 20;

  toast('Global difficulty cleared', 'success');
}

function loadSwipeHistory() {
  const container = document.querySelector('[data-swipe-history]');
  if (!container) return;

  if (swipeHistory.length === 0) {
    container.innerHTML = '<p>No swipe history yet</p>';
    return;
  }

  let html = '<div class="history-list">';
  for (let i = swipeHistory.length - 1; i >= 0; i--) {
    const item = swipeHistory[i];
    const actionClass = item.action === 'approve' ? 'approved' : 'skipped';
    const actionLabel = item.action === 'approve' ? '✓ Approved' : '✕ Skipped';

    html += `
      <div class="history-item ${actionClass}">
        <div class="item-title">${esc(item.title)}</div>
        <span class="item-action">${actionLabel}</span>
      </div>
    `;
  }
  html += '</div>';
  container.innerHTML = html;
}

async function testCredentials() {
  try {
    const resp = await fetch('/api/test-credentials', { method: 'POST' });
    if (!resp.ok) throw new Error('Failed');
    const data = await resp.json();

    if (data.success || data.ok) {
      toast('Credentials valid!', 'success');
    } else {
      toast('Credentials invalid: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    console.error('Error testing credentials:', err);
    toast('Failed to test credentials', 'error');
  }
}

// ============================================================================
// MINI PLAYER
// ============================================================================

function togglePreview(bmsId, btn) {
  const player = document.querySelector('[data-player-bar]');
  if (!player) return;

  const preview_url = `https://b.ppy.sh/preview/${bmsId}.mp3`;

  if (player.dataset.currentBmsId === String(bmsId)) {
    playerToggle();
  } else {
    player.dataset.currentBmsId = bmsId;
    const audio = document.querySelector('#preview-audio');
    if (audio) {
      audio.src = preview_url;
      audio.volume = 0.3;
      playerPlay();
    }
  }
}

function playerToggle() {
  const audio = document.querySelector('#preview-audio');
  if (!audio) return;

  if (audio.paused) {
    audio.play();
    const btn = document.querySelector('[data-player-play-btn]');
    if (btn) btn.textContent = '⏸';
  } else {
    audio.pause();
    const btn = document.querySelector('[data-player-play-btn]');
    if (btn) btn.textContent = '▶';
  }
}

function playerPlay() {
  const audio = document.querySelector('#preview-audio');
  if (audio) {
    audio.play();
    const btn = document.querySelector('[data-player-play-btn]');
    if (btn) btn.textContent = '⏸';
  }
}

function playerStop() {
  const audio = document.querySelector('#preview-audio');
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
    const btn = document.querySelector('[data-player-play-btn]');
    if (btn) btn.textContent = '▶';
  }
}

function playerSeek(time) {
  const audio = document.querySelector('#preview-audio');
  if (audio) {
    audio.currentTime = time;
  }
}

function playerVolume(vol) {
  const audio = document.querySelector('#preview-audio');
  if (audio) {
    audio.volume = Math.max(0, Math.min(1, vol));
  }
}

// ============================================================================
// SSE (SERVER-SENT EVENTS)
// ============================================================================

function startSSE() {
  if (sseSource) sseSource.close();

  sseSource = new EventSource('/events');

  sseSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.event === 'new_play') {
        toast('New top play detected!', 'info');
        loadTopPlays();
        loadCurrentRecommendations();
      }
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  };

  sseSource.onerror = (err) => {
    console.error('SSE error:', err);
    sseSource.close();
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function esc(str) {
  if (typeof str !== 'string') return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return str.replace(/[&<>"']/g, m => map[m]);
}

function starColorClass(sr) {
  if (sr < 2) return 'star-gray';
  if (sr < 2.7) return 'star-blue';
  if (sr < 4) return 'star-cyan';
  if (sr < 5.3) return 'star-green';
  if (sr < 6.3) return 'star-yellow';
  if (sr < 7.7) return 'star-orange';
  return 'star-red';
}

function fmtLen(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function toast(msg, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('show');
  }, 10);

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function renderTypeBadges(tags) {
  return tags.map(tag => `<span class="type-badge">${esc(tag)}</span>`).join('');
}

function calcModifiedStats(bm, mods) {
  let bpm = bm.bpm || 0;
  let ar = bm.ar || 0;
  let od = bm.accuracy || 0;

  if (mods.includes('DT')) {
    bpm *= 1.5;
    ar = Math.min(ar * 1.4 + 0.6, 11);
  }
  if (mods.includes('HR')) {
    ar = Math.min(ar * 1.4, 10);
  }
  if (mods.includes('EZ')) {
    ar = ar / 2;
  }

  return {
    bpm: Math.round(bpm),
    ar: ar.toFixed(1),
    od: od.toFixed(1)
  };
}

function exportRecs() {
  const csv = currentRecs.map(rec => {
    const bm = rec.beatmap || {};
    return [
      bm.id,
      bm.title,
      bm.artist,
      bm.creator,
      bm.difficulty_rating,
      bm.ar,
      bm.bpm,
      rec.reason
    ].join(',');
  }).join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `recs-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportLiked() {
  const csv = Array.from(likedBmsIds).join('\n');
  const blob = new Blob([csv], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `liked-${new Date().toISOString().split('T')[0]}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// Load global SR bounds from localStorage on page load
document.addEventListener('DOMContentLoaded', () => {
  const stored_min = localStorage.getItem('globalSrMin');
  const stored_max = localStorage.getItem('globalSrMax');
  if (stored_min !== null) globalSrMin = parseFloat(stored_min);
  if (stored_max !== null) globalSrMax = parseFloat(stored_max);
});
