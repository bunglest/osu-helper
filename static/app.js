/* ═══════════════════════════════════════════════════════════════════
   osu!helper — Frontend Application
   Complete rewrite matching index.html element IDs and CSS classes
   ═══════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  /* ─── State ─────────────────────────────────────────────────── */
  let currentTab = "plays";
  let playsData = [];
  let recsData = [];
  let exploreData = [];
  let likedIds = new Set();
  let dismissedIds = new Set();
  let blockedMappers = new Set();
  let meData = null;
  let activeCat = "all";
  let activeStatusFilter = "all";
  let activeRecMods = [];
  let recMode = "profile"; // "profile" or "play"
  let recPlayIndex = null;
  let playsView = "grid";
  let likedTabLoaded = false;
  let tasteTabLoaded = false;
  let _radarChart = null;
  let _driftChart = null;
  let _sseSource = null;
  let swipeQueue = [];
  let swipeIdx = 0;
  let activeExploreSkill = "all";
  let activeExploreMod = "";

  /* ─── Audio Player State ────────────────────────────────────── */
  let _audio = null;
  let _audioPlaying = false;
  let _audioBmsId = null;
  let _audioRaf = null;

  /* ─── DOM Helpers ───────────────────────────────────────────── */
  const $ = (id) => document.getElementById(id);
  const $q = (sel) => document.querySelector(sel);
  const $qa = (sel) => document.querySelectorAll(sel);

  /* ─── Utilities ─────────────────────────────────────────────── */

  function toast(msg, type = "info") {
    const container = $("toast-container");
    if (!container) return;
    const el = document.createElement("div");
    const typeMap = { success: "ok", error: "err", info: "info" };
    el.className = `toast toast-${typeMap[type] || type}`;
    el.textContent = msg;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 400);
    }, 3200);
  }

  /** Star-rating → CSS class matching style.css .stars-1 … .stars-7 */
  function starColorClass(sr) {
    if (sr < 2) return "stars-1";
    if (sr < 2.7) return "stars-2";
    if (sr < 4) return "stars-3";
    if (sr < 5.3) return "stars-4";
    if (sr < 6.5) return "stars-5";
    if (sr < 8) return "stars-6";
    return "stars-7";
  }

  function rankColor(rank) {
    const m = { SS: "#ffe566", S: "#ffcc22", A: "#88dd55", B: "#66bbff", C: "#dd88ff", D: "#ff6666" };
    return m[rank] || m[rank?.replace("H", "")] || "#aaa";
  }

  function formatLength(secs) {
    if (!secs) return "0:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function coverUrl(bms, size = "cover") {
    if (bms?.covers?.[size]) return bms.covers[size];
    if (bms?.covers?.["cover"]) return bms.covers["cover"];
    if (bms?.id) return `https://assets.ppy.sh/beatmaps/${bms.id}/covers/${size}.jpg`;
    return "";
  }

  function previewAudioUrl(bmsId) {
    return `https://b.ppy.sh/preview/${bmsId}.mp3`;
  }

  function renderTypeBadges(types) {
    if (!types || !Array.isArray(types) || types.length === 0) return "";
    return types
      .map((t) => {
        const cls = "type-" + t.toLowerCase().replace(/\s+/g, "-");
        return `<span class="type-badge ${cls}">${t}</span>`;
      })
      .join("");
  }

  function calcModifiedStats(bm, mods) {
    if (!mods || !Array.isArray(mods)) return { ar: bm.ar, bpm: bm.bpm, sr: bm.difficulty_rating };
    let ar = bm.ar || 0;
    let bpm = bm.bpm || 0;
    let sr = bm.difficulty_rating || 0;
    if (mods.includes("DT") || mods.includes("NC")) {
      bpm = Math.round(bpm * 1.5);
      const ms = ar <= 5 ? 1800 - 120 * ar : 1200 - 150 * (ar - 5);
      const newMs = ms / 1.5;
      ar = newMs > 1200 ? (1800 - newMs) / 120 : 5 + (1200 - newMs) / 150;
      ar = Math.min(11, Math.round(ar * 100) / 100);
    }
    if (mods.includes("HT")) {
      bpm = Math.round(bpm * 0.75);
    }
    if (mods.includes("HR")) {
      ar = Math.min(10, ar * 1.4);
      ar = Math.round(ar * 100) / 100;
    }
    if (mods.includes("EZ")) {
      ar = ar / 2;
    }
    return { ar, bpm, sr };
  }

  function modIncompat(current, mod) {
    const pairs = { HR: "EZ", EZ: "HR", DT: "HT", HT: "DT" };
    return pairs[mod] && current.includes(pairs[mod]);
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }

  /* ─── Tab Navigation ────────────────────────────────────────── */

  function setupTabs() {
    // Desktop tabs
    $qa(".tab[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
    // Mobile tabs
    $qa(".mobile-tab[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
  }

  function switchTab(tab) {
    currentTab = tab;
    // Update desktop tab buttons
    $qa(".tab[data-tab]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
      b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false");
    });
    // Update mobile tab buttons
    $qa(".mobile-tab[data-tab]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    // Show/hide tab panels
    $qa(".tab-content").forEach((p) => {
      p.classList.toggle("active", p.id === `tab-${tab}`);
    });
    // Lazy-load tab data
    if (tab === "plays" && playsData.length === 0) loadTopPlays();
    if (tab === "recs" && recsData.length === 0) loadRecommendations();
    if (tab === "liked" && !likedTabLoaded) loadLikedTab();
    if (tab === "taste" && !tasteTabLoaded) loadTasteProfile();
    if (tab === "settings") populateSettings();
  }

  /* ─── Audio Mini Player ─────────────────────────────────────── */

  function initPlayer() {
    _audio = new Audio();
    _audio.volume = 0.3;
    _audio.addEventListener("ended", () => stopPlayer());
    _audio.addEventListener("error", () => {
      toast("Could not load audio preview", "error");
      stopPlayer();
    });
  }

  function playPreview(bmsId, title, artist, coverSrc) {
    if (!_audio) initPlayer();
    const bar = $("player-bar");
    if (_audioBmsId === bmsId && _audioPlaying) {
      togglePlayer();
      return;
    }
    _audioBmsId = bmsId;
    _audio.src = previewAudioUrl(bmsId);
    _audio.currentTime = 0;
    _audio.play().catch(() => {});
    _audioPlaying = true;
    // Update UI
    $("player-cover").src = coverSrc || "";
    $("player-title").textContent = title || "—";
    $("player-artist").textContent = artist || "—";
    bar.classList.remove("hidden");
    updatePlayPauseIcon(true);
    startSeekUpdate();
  }

  function togglePlayer() {
    if (!_audio) return;
    if (_audioPlaying) {
      _audio.pause();
      _audioPlaying = false;
      updatePlayPauseIcon(false);
      cancelAnimationFrame(_audioRaf);
    } else {
      _audio.play().catch(() => {});
      _audioPlaying = true;
      updatePlayPauseIcon(true);
      startSeekUpdate();
    }
  }

  function stopPlayer() {
    if (_audio) {
      _audio.pause();
      _audio.src = "";
    }
    _audioPlaying = false;
    _audioBmsId = null;
    cancelAnimationFrame(_audioRaf);
    const bar = $("player-bar");
    if (bar) bar.classList.add("hidden");
  }

  function updatePlayPauseIcon(playing) {
    const btn = $("player-playpause");
    if (!btn) return;
    btn.innerHTML = playing
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  }

  function startSeekUpdate() {
    cancelAnimationFrame(_audioRaf);
    function tick() {
      if (!_audio || !_audioPlaying) return;
      const dur = _audio.duration || 30;
      const cur = _audio.currentTime || 0;
      const seek = $("player-seek");
      if (seek) seek.value = (cur / dur) * 100;
      const timeEl = $("player-time");
      if (timeEl) timeEl.textContent = formatTime(cur);
      const durEl = $("player-duration");
      if (durEl) durEl.textContent = formatTime(dur);
      _audioRaf = requestAnimationFrame(tick);
    }
    _audioRaf = requestAnimationFrame(tick);
  }

  // Global functions for inline onclick handlers
  window.playerToggle = togglePlayer;
  window.playerStop = stopPlayer;
  window.playerSeek = function (val) {
    if (!_audio) return;
    const dur = _audio.duration || 30;
    _audio.currentTime = (val / 100) * dur;
  };
  window.playerVolume = function (val) {
    if (!_audio) initPlayer();
    _audio.volume = val / 100;
  };

  /* ─── View Toggle ───────────────────────────────────────────── */

  function setupViewToggle() {
    $qa(".view-btn[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        playsView = view;
        $qa(".view-btn[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
        const grid = $("plays-grid");
        if (grid) {
          grid.classList.toggle("list-view", view === "list");
        }
      });
    });
  }

  /* ─── Top Plays ─────────────────────────────────────────────── */

  function loadTopPlays() {
    const loading = $("plays-loading");
    const error = $("plays-error");
    const empty = $("plays-empty");
    const grid = $("plays-grid");
    if (loading) loading.classList.remove("hidden");
    if (error) error.classList.add("hidden");
    if (empty) empty.classList.add("hidden");
    if (grid) grid.classList.add("hidden");

    fetch("/api/top-plays")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (loading) loading.classList.add("hidden");
        if (data.error) throw new Error(data.error);
        playsData = data.plays || [];
        if (playsData.length === 0) {
          if (empty) empty.classList.remove("hidden");
          return;
        }
        renderPlays();
        if (grid) grid.classList.remove("hidden");
        $("plays-subtitle").textContent = `Your top ${playsData.length} scores`;
      })
      .catch((err) => {
        if (loading) loading.classList.add("hidden");
        const msg = $("plays-error-msg");
        if (msg) msg.textContent = err.message || "Something went wrong";
        if (error) error.classList.remove("hidden");
      });
  }
  window.loadTopPlays = loadTopPlays;

  function renderPlays() {
    const grid = $("plays-grid");
    if (!grid) return;
    grid.innerHTML = "";
    playsData.forEach((play, idx) => {
      grid.appendChild(buildPlayCard(play, idx));
    });
    if (playsView === "list") grid.classList.add("list-view");
  }

  function buildPlayCard(play, idx) {
    const bm = play.beatmap || {};
    const bms = play.beatmapset || {};
    const sr = bm.difficulty_rating || 0;
    const cover = coverUrl(bms);
    const rank = play.rank || "?";
    const pp = play.pp ? Math.round(play.pp) : "—";
    const acc = play.accuracy != null ? (play.accuracy * 100).toFixed(2) : "—";
    const mods = play.mods || [];
    const types = bm.map_types || [];

    const card = document.createElement("div");
    card.className = "play-card";
    card.innerHTML = `
      <div class="play-cover" style="background-image:url('${escHtml(cover)}')">
        <div class="play-cover-overlay"></div>
        <span class="play-rank-badge" style="color:${rankColor(rank)}">${escHtml(rank)}</span>
        <button class="play-preview-btn" title="Preview audio" aria-label="Preview audio">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
      <div class="play-body">
        <div class="play-title" title="${escHtml(bms.title)} [${escHtml(bm.version)}]">
          ${escHtml(bms.title)} <span class="play-diff">[${escHtml(bm.version)}]</span>
        </div>
        <div class="play-artist">${escHtml(bms.artist)} // ${escHtml(bms.creator)}</div>
        <div class="play-stats">
          <span class="stat-pill ${starColorClass(sr)}">★ ${sr.toFixed(2)}</span>
          <span class="stat-pill">AR ${bm.ar || 0}</span>
          <span class="stat-pill">BPM ${bm.bpm || 0}</span>
          <span class="stat-pill">${formatLength(bm.total_length)}</span>
          ${mods.length ? `<span class="stat-pill mod-pill">+${mods.join("")}</span>` : ""}
        </div>
        ${types.length ? `<div class="play-types">${renderTypeBadges(types)}</div>` : ""}
      </div>
      <div class="play-footer">
        <span class="play-pp">${pp}pp</span>
        <span class="play-acc">${acc}%</span>
      </div>
      <div class="play-actions">
        <button class="play-action-btn" title="Find similar maps" data-action="recs" aria-label="Find similar maps">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
        </button>
        <a href="https://osu.ppy.sh/beatmapsets/${bms.id}#osu/${bm.id}" target="_blank" rel="noopener" class="play-action-btn" title="View on osu!" aria-label="View on osu!">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
        </a>
      </div>
    `;

    // Preview audio button
    card.querySelector(".play-preview-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      playPreview(bms.id, bms.title, bms.artist, cover);
    });

    // Find similar recs button
    card.querySelector('[data-action="recs"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      loadRecommendationsForPlay(idx);
    });

    return card;
  }

  function loadRecommendationsForPlay(index) {
    recMode = "play";
    recPlayIndex = index;
    switchTab("recs");
    const play = playsData[index];
    const bms = play?.beatmapset || {};
    $("recs-title").textContent = `Recs for: ${bms.title || "Play #" + (index + 1)}`;
    $("recs-subtitle").textContent = `Maps similar to this play`;
    $("recs-profile-btn")?.classList.remove("hidden");
    _loadRecommendations(`/api/recommendations/for-play/${index}`);
  }

  window.switchRecMode = function (mode) {
    recMode = "profile";
    recPlayIndex = null;
    $("recs-title").textContent = "Recommendations";
    $("recs-subtitle").textContent = "Based on your overall taste profile";
    $("recs-profile-btn")?.classList.add("hidden");
    _loadRecommendations();
  };

  /* ─── Recommendations ───────────────────────────────────────── */

  function _loadRecommendations(url) {
    const loading = $("recs-loading");
    const error = $("recs-error");
    const emptyCat = $("recs-empty-cat");
    const grid = $("recs-grid");
    if (loading) loading.classList.remove("hidden");
    if (error) error.classList.add("hidden");
    if (emptyCat) emptyCat.classList.add("hidden");
    if (grid) { grid.classList.add("hidden"); grid.innerHTML = ""; }

    let endpoint = url || "/api/recommendations";
    if (!url && activeRecMods.length > 0) {
      endpoint += `?mod_filter=${activeRecMods.join(",")}`;
    }

    fetch(endpoint)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (loading) loading.classList.add("hidden");
        if (data.error) throw new Error(data.error);
        recsData = data.recommendations || [];
        renderRecs();
        if (grid) grid.classList.remove("hidden");
      })
      .catch((err) => {
        if (loading) loading.classList.add("hidden");
        const msg = $("recs-error-msg");
        if (msg) msg.textContent = err.message || "Could not load recommendations";
        if (error) error.classList.remove("hidden");
      });
  }

  function loadRecommendations() {
    recMode = "profile";
    _loadRecommendations();
  }
  window.loadRecommendations = loadRecommendations;

  function renderRecs() {
    const grid = $("recs-grid");
    const emptyCat = $("recs-empty-cat");
    if (!grid) return;
    grid.innerHTML = "";
    let filtered = recsData;
    if (activeCat !== "all") {
      filtered = recsData.filter((r) => (r.category || "best_match") === activeCat);
    }
    if (activeStatusFilter !== "all") {
      filtered = filtered.filter((r) => {
        const status = (r.beatmapset?.status || "").toLowerCase();
        if (activeStatusFilter === "ranked") return status === "ranked" || status === "approved";
        if (activeStatusFilter === "loved") return status === "loved";
        return true;
      });
    }
    if (filtered.length === 0) {
      if (emptyCat) emptyCat.classList.remove("hidden");
      grid.classList.add("hidden");
      return;
    }
    if (emptyCat) emptyCat.classList.add("hidden");
    grid.classList.remove("hidden");
    filtered.forEach((rec) => grid.appendChild(buildRecCard(rec)));
  }

  function buildRecCard(rec) {
    const bm = rec.beatmap || {};
    const bms = rec.beatmapset || {};
    const sr = bm.difficulty_rating || 0;
    const cover = coverUrl(bms);
    const types = bm.map_types || [];
    const reason = rec.reason || "";
    const isLiked = likedIds.has(bms.id);

    const card = document.createElement("div");
    card.className = "rec-card";
    card.dataset.bmsId = bms.id;
    card.innerHTML = `
      <div class="rec-cover" style="background-image:url('${escHtml(cover)}')">
        <div class="rec-cover-overlay"></div>
        <span class="rec-stars ${starColorClass(sr)}">★ ${sr.toFixed(2)}</span>
        <button class="rec-preview-btn" title="Preview audio" aria-label="Preview audio">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
      <div class="rec-body">
        <div class="rec-title" title="${escHtml(bms.title)} [${escHtml(bm.version)}]">${escHtml(bms.title)}</div>
        <div class="rec-mapper">${escHtml(bms.artist)} // ${escHtml(bms.creator)}</div>
        <div class="rec-attrs">
          <span class="attr-chip">AR ${bm.ar || 0}</span>
          <span class="attr-chip">BPM ${bm.bpm || 0}</span>
          <span class="attr-chip">${formatLength(bm.total_length)}</span>
        </div>
        ${types.length ? `<div class="rec-types">${renderTypeBadges(types)}</div>` : ""}
        ${reason ? `<div class="rec-reason" title="${escHtml(reason)}">${escHtml(reason)}</div>` : ""}
      </div>
      <div class="rec-actions">
        <button class="rec-action-btn rec-like-btn ${isLiked ? "liked" : ""}" title="${isLiked ? "Unlike" : "Interested"}" data-action="like" aria-label="${isLiked ? "Unlike" : "Interested"}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        </button>
        <button class="rec-action-btn" title="Dismiss" data-action="dismiss" aria-label="Dismiss">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
        <a href="https://osu.ppy.sh/beatmapsets/${bms.id}#osu/${bm.id}" target="_blank" rel="noopener" class="rec-action-btn" title="View on osu!" aria-label="View on osu!">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
        </a>
        <a href="osu://dl/${bms.id}" class="rec-action-btn" title="Download (osu!direct)" aria-label="Download">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </a>
      </div>
    `;

    // Preview audio
    card.querySelector(".rec-preview-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      playPreview(bms.id, bms.title, bms.artist, cover);
    });

    // Like
    card.querySelector('[data-action="like"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLike(bms.id, bm, bms, card);
    });

    // Dismiss
    card.querySelector('[data-action="dismiss"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      dismissRec(bms.id, bm, bms, card);
    });

    return card;
  }

  function toggleLike(bmsId, bm, bms, card) {
    if (likedIds.has(bmsId)) {
      // Unlike
      fetch(`/api/feedback/like/${bmsId}`, { method: "DELETE" })
        .then((r) => r.json())
        .then(() => {
          likedIds.delete(bmsId);
          const btn = card.querySelector('[data-action="like"]');
          if (btn) { btn.classList.remove("liked"); btn.title = "Interested"; }
          toast("Removed from liked", "info");
        })
        .catch(() => toast("Failed to unlike", "error"));
    } else {
      fetch("/api/feedback/like", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beatmapset_id: bmsId,
          beatmap_id: bm.id,
          bm: bm,
          bms: bms,
        }),
      })
        .then((r) => r.json())
        .then(() => {
          likedIds.add(bmsId);
          const btn = card.querySelector('[data-action="like"]');
          if (btn) { btn.classList.add("liked"); btn.title = "Unlike"; }
          toast("Added to liked!", "success");
        })
        .catch(() => toast("Failed to like", "error"));
    }
  }

  // Global alias for inline onclick
  window.likeRecById = function (bmsId) {
    const rec = recsData.find((r) => r.beatmapset?.id === bmsId);
    if (!rec) return;
    const card = $q(`.rec-card[data-bms-id="${bmsId}"]`);
    if (card) toggleLike(bmsId, rec.beatmap, rec.beatmapset, card);
  };

  function dismissRec(bmsId, bm, bms, card) {
    card.classList.add("dismissing");
    fetch("/api/dismissed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ beatmapset_id: bmsId, bm: bm, bms: bms }),
    })
      .then((r) => r.json())
      .then(() => {
        dismissedIds.add(bmsId);
        setTimeout(() => {
          recsData = recsData.filter((r) => r.beatmapset?.id !== bmsId);
          renderRecs();
        }, 350);
        toast("Dismissed", "info");
      })
      .catch(() => {
        card.classList.remove("dismissing");
        toast("Failed to dismiss", "error");
      });
  }

  window.dismissRecById = function (bmsId) {
    const rec = recsData.find((r) => r.beatmapset?.id === bmsId);
    if (!rec) return;
    const card = $q(`.rec-card[data-bms-id="${bmsId}"]`);
    if (card) dismissRec(bmsId, rec.beatmap, rec.beatmapset, card);
  };

  /* ─── Rec Mod Toggles ──────────────────────────────────────── */

  function setupRecModToggles() {
    $qa(".rec-mod-toggle[data-mod]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mod = btn.dataset.mod;
        // Handle incompatibility
        if (modIncompat(activeRecMods, mod)) {
          const incompat = { HR: "EZ", EZ: "HR", DT: "HT", HT: "DT" }[mod];
          activeRecMods = activeRecMods.filter((m) => m !== incompat);
          $qa(".rec-mod-toggle[data-mod]").forEach((b) => {
            if (b.dataset.mod === incompat) {
              b.classList.remove("active");
              b.setAttribute("aria-pressed", "false");
            }
          });
        }
        const isActive = activeRecMods.includes(mod);
        if (isActive) {
          activeRecMods = activeRecMods.filter((m) => m !== mod);
          btn.classList.remove("active");
          btn.setAttribute("aria-pressed", "false");
        } else {
          activeRecMods.push(mod);
          btn.classList.add("active");
          btn.setAttribute("aria-pressed", "true");
        }
        _loadRecommendations();
      });
    });
  }

  /* ─── Category Tabs ─────────────────────────────────────────── */

  function setupCatTabs() {
    $qa(".cat-tab[data-cat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeCat = btn.dataset.cat;
        $qa(".cat-tab[data-cat]").forEach((b) => b.classList.toggle("active", b.dataset.cat === activeCat));
        renderRecs();
      });
    });
  }

  /* ─── Status Filter ─────────────────────────────────────────── */

  function setupStatusFilter() {
    $qa(".status-btn[data-status]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeStatusFilter = btn.dataset.status;
        $qa(".status-btn[data-status]").forEach((b) => b.classList.toggle("active", b.dataset.status === activeStatusFilter));
        renderRecs();
      });
    });
  }

  /* ─── Explore Tab ───────────────────────────────────────────── */

  function setupExplore() {
    // Skill category buttons
    $qa(".skill-cat-btn[data-skill]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeExploreSkill = btn.dataset.skill;
        $qa(".skill-cat-btn[data-skill]").forEach((b) => b.classList.toggle("active", b.dataset.skill === activeExploreSkill));
      });
    });

    // Mod buttons
    $qa(".explore-mod-btn[data-mod]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeExploreMod = btn.dataset.mod;
        $qa(".explore-mod-btn[data-mod]").forEach((b) => b.classList.toggle("active", b.dataset.mod === activeExploreMod));
      });
    });

    // Dual range sliders
    setupDualSlider("sr-slider", "explore-sr-min", "explore-sr-max", 0, 150, 10);
    setupDualSlider("bpm-slider", "explore-bpm-min", "explore-bpm-max", 60, 400, 1);
    setupDualSlider("global-sr-slider", "global-sr-min", "global-sr-max", 0, 200, 10);
  }

  function setupDualSlider(sliderId, minInputId, maxInputId, rangeMin, rangeMax, divisor) {
    const slider = $(sliderId);
    if (!slider) return;
    const thumbMin = slider.querySelector(".thumb-min");
    const thumbMax = slider.querySelector(".thumb-max");
    const range = slider.querySelector(".slider-range");
    const minInput = $(minInputId);
    const maxInput = $(maxInputId);
    if (!thumbMin || !thumbMax || !range) return;

    function updateRange() {
      const min = parseInt(thumbMin.value);
      const max = parseInt(thumbMax.value);
      const sliderMin = parseInt(thumbMin.min);
      const sliderMax = parseInt(thumbMin.max);
      const total = sliderMax - sliderMin;
      const left = ((Math.min(min, max) - sliderMin) / total) * 100;
      const right = ((sliderMax - Math.max(min, max)) / total) * 100;
      range.style.left = left + "%";
      range.style.right = right + "%";
      // Sync number inputs
      if (minInput) minInput.value = (Math.min(min, max) / divisor).toFixed(divisor >= 10 ? 1 : 0);
      if (maxInput) maxInput.value = (Math.max(min, max) / divisor).toFixed(divisor >= 10 ? 1 : 0);
    }

    thumbMin.addEventListener("input", updateRange);
    thumbMax.addEventListener("input", updateRange);

    // Sync number inputs back to sliders
    if (minInput) {
      minInput.addEventListener("change", () => {
        thumbMin.value = Math.round(parseFloat(minInput.value) * divisor);
        updateRange();
      });
    }
    if (maxInput) {
      maxInput.addEventListener("change", () => {
        thumbMax.value = Math.round(parseFloat(maxInput.value) * divisor);
        updateRange();
      });
    }

    updateRange();
  }

  window.loadExploreRecs = function () {
    const srMin = parseFloat($("explore-sr-min")?.value || 3);
    const srMax = parseFloat($("explore-sr-max")?.value || 7);
    const bpmMin = parseFloat($("explore-bpm-min")?.value || 120);
    const bpmMax = parseFloat($("explore-bpm-max")?.value || 240);
    const ar = parseFloat($("explore-ar")?.value || 9);
    const sr = (srMin + srMax) / 2;
    const bpm = (bpmMin + bpmMax) / 2;

    const loading = $("explore-loading");
    const error = $("explore-error");
    const grid = $("explore-grid");
    if (loading) loading.classList.remove("hidden");
    if (error) error.classList.add("hidden");
    if (grid) { grid.classList.add("hidden"); grid.innerHTML = ""; }

    const params = new URLSearchParams({ sr, ar, bpm });
    fetch(`/api/recommendations/explore?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (loading) loading.classList.add("hidden");
        if (data.error) throw new Error(data.error);
        exploreData = data.recommendations || [];
        if (grid) {
          grid.innerHTML = "";
          exploreData.forEach((rec) => grid.appendChild(buildRecCard(rec)));
          grid.classList.remove("hidden");
        }
        if (exploreData.length === 0) {
          toast("No maps found matching those criteria", "info");
        }
      })
      .catch((err) => {
        if (loading) loading.classList.add("hidden");
        const msg = $("explore-error-msg");
        if (msg) msg.textContent = err.message || "Something went wrong";
        if (error) error.classList.remove("hidden");
      });
  };

  /* ─── Liked Tab ─────────────────────────────────────────────── */

  function loadLikedTab() {
    likedTabLoaded = true;
    const loading = $("liked-loading");
    const empty = $("liked-empty");
    const grid = $("liked-grid");
    if (loading) loading.classList.remove("hidden");
    if (empty) empty.classList.add("hidden");
    if (grid) { grid.classList.add("hidden"); grid.innerHTML = ""; }

    fetch("/api/feedback")
      .then((r) => r.json())
      .then((data) => {
        if (loading) loading.classList.add("hidden");
        const entries = data.entries || [];
        likedIds = new Set(data.liked || []);
        if (entries.length === 0) {
          if (empty) empty.classList.remove("hidden");
          return;
        }
        entries.forEach((entry) => grid.appendChild(buildLikedCard(entry)));
        if (grid) grid.classList.remove("hidden");
      })
      .catch(() => {
        if (loading) loading.classList.add("hidden");
        toast("Failed to load liked maps", "error");
      });
  }
  window.loadLikedTab = loadLikedTab;

  function buildLikedCard(entry) {
    const bmsId = entry.bms_id;
    const sr = entry.sr || 0;
    const title = entry.title || `Beatmapset #${bmsId}`;
    const artist = entry.artist || "—";
    const creator = entry.creator || "—";
    const version = entry.version || "";
    const cover = entry.covers?.cover
      ? entry.covers.cover
      : `https://assets.ppy.sh/beatmaps/${bmsId}/covers/cover.jpg`;
    const types = entry.map_types || [];

    const card = document.createElement("div");
    card.className = "rec-card";
    card.dataset.bmsId = bmsId;
    card.innerHTML = `
      <div class="rec-cover" style="background-image:url('${escHtml(cover)}')">
        <div class="rec-cover-overlay"></div>
        <span class="rec-stars ${starColorClass(sr)}">★ ${sr.toFixed(2)}</span>
        <button class="rec-preview-btn" title="Preview audio" aria-label="Preview audio">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
      <div class="rec-body">
        <div class="rec-title">${escHtml(title)}${version ? ` <span class="play-diff">[${escHtml(version)}]</span>` : ""}</div>
        <div class="rec-mapper">${escHtml(artist)} // ${escHtml(creator)}</div>
        <div class="rec-attrs">
          ${entry.ar != null ? `<span class="attr-chip">AR ${entry.ar}</span>` : ""}
          ${entry.bpm != null ? `<span class="attr-chip">BPM ${Math.round(entry.bpm)}</span>` : ""}
        </div>
        ${types.length ? `<div class="rec-types">${renderTypeBadges(types)}</div>` : ""}
      </div>
      <div class="rec-actions">
        <button class="rec-action-btn rec-unlike-btn" title="Remove from liked" data-action="unlike" aria-label="Remove from liked">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
        <a href="https://osu.ppy.sh/beatmapsets/${bmsId}" target="_blank" rel="noopener" class="rec-action-btn" title="View on osu!">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
        </a>
        <a href="osu://dl/${bmsId}" class="rec-action-btn" title="Download" aria-label="Download">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </a>
      </div>
    `;

    // Preview audio
    card.querySelector(".rec-preview-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      playPreview(bmsId, title, artist, cover);
    });

    // Unlike
    card.querySelector('[data-action="unlike"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      card.classList.add("dismissing");
      fetch(`/api/feedback/like/${bmsId}`, { method: "DELETE" })
        .then((r) => r.json())
        .then(() => {
          likedIds.delete(bmsId);
          setTimeout(() => card.remove(), 350);
          toast("Removed from liked", "info");
          // Check if grid is empty now
          const grid = $("liked-grid");
          if (grid && grid.children.length <= 1) {
            $("liked-empty")?.classList.remove("hidden");
            grid.classList.add("hidden");
          }
        })
        .catch(() => {
          card.classList.remove("dismissing");
          toast("Failed to remove", "error");
        });
    });

    return card;
  }

  /* ─── Taste Profile Tab ─────────────────────────────────────── */

  function loadTasteProfile() {
    tasteTabLoaded = true;
    Promise.all([
      fetch("/api/profile-stats").then((r) => r.json()),
      fetch("/api/taste-snapshots").then((r) => r.json()),
      fetch("/api/recommendations").then((r) => r.json()),
    ])
      .then(([stats, snapshots, recs]) => {
        renderTasteRadar(stats);
        renderTasteDrift(snapshots);
        // Use recs for swipe queue
        swipeQueue = (recs.recommendations || []).slice(0, 20);
        swipeIdx = 0;
        renderSwipeCard();
      })
      .catch((err) => {
        console.error("Taste profile error:", err);
        toast("Failed to load taste profile", "error");
      });
  }

  function renderTasteRadar(stats) {
    if (stats.error) return;
    const canvas = $("taste-radar");
    if (!canvas) return;
    const axes = stats.axes || [];
    const typeWeights = stats.type_weights || {};
    const dominantMods = stats.dominant_mods || [];
    const skillGap = stats.skill_gap;

    // Radar chart with Chart.js
    const labels = axes.map((a) => a.label);
    const values = axes.map((a) => ((a.value || 0) / (a.max || 1)) * 100);

    if (_radarChart) _radarChart.destroy();
    _radarChart = new Chart(canvas, {
      type: "radar",
      data: {
        labels,
        datasets: [
          {
            label: "Your Profile",
            data: values,
            backgroundColor: "rgba(255,45,120,0.15)",
            borderColor: "#ff2d78",
            borderWidth: 2,
            pointBackgroundColor: "#ff2d78",
            pointRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        scales: {
          r: {
            beginAtZero: true,
            max: 100,
            ticks: { display: false },
            grid: { color: "rgba(255,255,255,0.08)" },
            angleLines: { color: "rgba(255,255,255,0.08)" },
            pointLabels: { color: "#ccc", font: { size: 11 } },
          },
        },
        plugins: { legend: { display: false } },
      },
    });

    // Type chips
    const chipsEl = $("taste-type-chips");
    if (chipsEl) {
      const sorted = Object.entries(typeWeights).sort((a, b) => b[1] - a[1]);
      chipsEl.innerHTML = sorted
        .map(([t, w]) => {
          const cls = "type-" + t.toLowerCase().replace(/\s+/g, "-");
          return `<span class="type-badge ${cls}">${t} ${(w * 100).toFixed(0)}%</span>`;
        })
        .join("");
    }

    // Breakdown
    const breakdown = $("taste-breakdown");
    if (breakdown) {
      let html = '<div class="taste-detail-list">';
      axes.forEach((a) => {
        html += `<div class="taste-detail-row">
          <span class="taste-detail-label">${a.label}</span>
          <div class="taste-detail-bar-wrap">
            <div class="taste-detail-bar" style="width:${((a.value / a.max) * 100).toFixed(1)}%"></div>
          </div>
          <span class="taste-detail-val">${a.value}</span>
        </div>`;
      });
      if (dominantMods.length) {
        html += `<div class="taste-detail-row"><span class="taste-detail-label">Dominant Mods</span><span class="taste-detail-val">+${dominantMods.join("")}</span></div>`;
      }
      html += "</div>";
      breakdown.innerHTML = html;
    }

    // Skill gap badge
    const gapBadge = $("skill-gap-badge");
    if (gapBadge) {
      if (skillGap) {
        gapBadge.textContent = `Skill Gap: ${skillGap}`;
        gapBadge.classList.remove("hidden");
      } else {
        gapBadge.classList.add("hidden");
      }
    }
  }

  function renderTasteDrift(data) {
    const canvas = $("drift-chart");
    const card = $("drift-chart-card");
    if (!canvas || !data.snapshots || data.snapshots.length < 2) return;
    if (card) card.classList.remove("hidden");

    const snaps = data.snapshots;
    const labels = snaps.map((s) => s.date);
    const srData = snaps.map((s) => s.sr);
    const arData = snaps.map((s) => s.ar);
    const bpmData = snaps.map((s) => (s.bpm || 0) / 10);

    if (_driftChart) _driftChart.destroy();
    _driftChart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "SR", data: srData, borderColor: "#ff2d78", borderWidth: 2, tension: 0.3, pointRadius: 3 },
          { label: "AR", data: arData, borderColor: "#00e5ff", borderWidth: 2, tension: 0.3, pointRadius: 3 },
          { label: "BPM/10", data: bpmData, borderColor: "#a78bfa", borderWidth: 2, tension: 0.3, pointRadius: 3 },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { ticks: { color: "#888", maxTicksLimit: 10 }, grid: { color: "rgba(255,255,255,0.05)" } },
          y: { ticks: { color: "#888" }, grid: { color: "rgba(255,255,255,0.05)" } },
        },
        plugins: { legend: { labels: { color: "#ccc" } } },
      },
    });
  }

  /* ─── Swipe Feature ─────────────────────────────────────────── */

  function renderSwipeCard() {
    if (swipeIdx >= swipeQueue.length) {
      $("swipe-title") && ($("swipe-title").textContent = "No more maps!");
      $("swipe-artist") && ($("swipe-artist").textContent = "Refresh recommendations to get more.");
      $("swipe-attrs") && ($("swipe-attrs").innerHTML = "");
      $("swipe-types") && ($("swipe-types").innerHTML = "");
      $("swipe-cover-img") && ($("swipe-cover-img").src = "");
      $("swipe-stars") && ($("swipe-stars").textContent = "");
      return;
    }
    const rec = swipeQueue[swipeIdx];
    const bm = rec.beatmap || {};
    const bms = rec.beatmapset || {};
    const sr = bm.difficulty_rating || 0;
    const cover = coverUrl(bms);

    $("swipe-cover-img") && ($("swipe-cover-img").src = cover);
    $("swipe-title") && ($("swipe-title").textContent = bms.title || "—");
    $("swipe-artist") && ($("swipe-artist").textContent = `${bms.artist || "—"} // ${bms.creator || "—"}`);
    $("swipe-stars") && ($("swipe-stars").textContent = `★ ${sr.toFixed(2)}`);
    $("swipe-stars")?.setAttribute("class", `swipe-stars ${starColorClass(sr)}`);

    const attrs = $("swipe-attrs");
    if (attrs) {
      attrs.innerHTML = `
        <span class="attr-chip">AR ${bm.ar || 0}</span>
        <span class="attr-chip">BPM ${bm.bpm || 0}</span>
        <span class="attr-chip">${formatLength(bm.total_length)}</span>
      `;
    }

    const typesEl = $("swipe-types");
    if (typesEl) typesEl.innerHTML = renderTypeBadges(bm.map_types);

    // Reset card position
    const card = $("swipe-card");
    if (card) {
      card.classList.remove("swiping-left", "swiping-right");
      card.style.transform = "";
      card.style.opacity = "";
    }
  }

  window.swipeAction = function (direction) {
    if (swipeIdx >= swipeQueue.length) return;
    const rec = swipeQueue[swipeIdx];
    const bms = rec.beatmapset || {};
    const bm = rec.beatmap || {};
    const card = $("swipe-card");

    if (card) {
      card.classList.add(direction === "right" ? "swiping-right" : "swiping-left");
    }

    if (direction === "right") {
      // Like / approve
      fetch("/api/feedback/like", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beatmapset_id: bms.id, beatmap_id: bm.id, bm, bms }),
      })
        .then((r) => r.json())
        .then(() => {
          likedIds.add(bms.id);
          toast("Added to liked!", "success");
        })
        .catch(() => {});
    } else {
      // Skip / dismiss
      fetch("/api/dismissed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beatmapset_id: bms.id, bm, bms }),
      })
        .then((r) => r.json())
        .then(() => {
          dismissedIds.add(bms.id);
        })
        .catch(() => {});
    }

    setTimeout(() => {
      swipeIdx++;
      renderSwipeCard();
    }, 400);
  };

  window.previewSwipeMap = function () {
    if (swipeIdx >= swipeQueue.length) return;
    const rec = swipeQueue[swipeIdx];
    const bms = rec.beatmapset || {};
    playPreview(bms.id, bms.title, bms.artist, coverUrl(bms));
  };

  /* ─── Taste Feedback Modal ──────────────────────────────────── */

  window.openTasteFeedback = function () {
    $("taste-feedback-modal")?.classList.remove("hidden");
  };
  window.closeTasteFeedback = function () {
    $("taste-feedback-modal")?.classList.add("hidden");
  };
  window.submitTasteFeedback = function () {
    const text = $("taste-feedback-text")?.value?.trim();
    if (!text) {
      toast("Please enter some feedback", "error");
      return;
    }
    toast("Thanks for your feedback!", "success");
    $("taste-feedback-modal")?.classList.add("hidden");
    if ($("taste-feedback-text")) $("taste-feedback-text").value = "";
  };

  /* ─── Settings ──────────────────────────────────────────────── */

  function populateSettings() {
    if (!meData) return;
    const topN = $("settings-top-n");
    const pollInterval = $("settings-poll-interval");
    const recCount = $("settings-rec-count");
    const useRecent = $("settings-use-recent");
    const username = $("settings-username");
    const clientId = $("settings-client-id");

    if (topN) topN.value = meData.top_n || 20;
    if (pollInterval) pollInterval.value = meData.poll_interval || 30;
    if (recCount) recCount.value = meData.rec_count || 12;
    if (useRecent) useRecent.checked = meData.use_recent_plays !== false;

    // Global SR filter
    const srMin = $("global-sr-min");
    const srMax = $("global-sr-max");
    if (srMin && meData.sr_min != null) srMin.value = meData.sr_min;
    if (srMax && meData.sr_max != null) srMax.value = meData.sr_max;

    // Mode-specific settings visibility
    if (meData.oauth_mode) {
      $("profiles-card")?.classList.add("hidden");
      $("credentials-card")?.classList.add("hidden");
      $("oauth-info-card")?.classList.remove("hidden");
      $("poll-interval-group")?.classList.add("hidden");
    } else {
      $("profiles-card")?.classList.remove("hidden");
      $("credentials-card")?.classList.remove("hidden");
      $("oauth-info-card")?.classList.add("hidden");
      $("poll-interval-group")?.classList.remove("hidden");
      if (username) username.value = meData.username || "";
      loadProfilesList();
    }

    // Preferred mods
    const prefMods = meData.preferred_mods || [];
    $qa("#mod-toggles .mod-toggle[data-mod]").forEach((btn) => {
      const mod = btn.dataset.mod;
      const active = mod === "NM" ? prefMods.length === 0 : prefMods.includes(mod);
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function setupModToggles() {
    $qa("#mod-toggles .mod-toggle[data-mod]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mod = btn.dataset.mod;
        if (mod === "NM") {
          // Clear all mods
          $qa("#mod-toggles .mod-toggle[data-mod]").forEach((b) => {
            b.classList.remove("active");
            b.setAttribute("aria-pressed", "false");
          });
          btn.classList.add("active");
          btn.setAttribute("aria-pressed", "true");
        } else {
          // Deactivate NM
          const nm = $q('#mod-toggles .mod-toggle[data-mod="NM"]');
          if (nm) { nm.classList.remove("active"); nm.setAttribute("aria-pressed", "false"); }
          // Handle incompatibility
          if (modIncompat(getSelectedMods(), mod)) {
            const incompat = { HR: "EZ", EZ: "HR", DT: "HT", HT: "DT" }[mod];
            const ib = $q(`#mod-toggles .mod-toggle[data-mod="${incompat}"]`);
            if (ib) { ib.classList.remove("active"); ib.setAttribute("aria-pressed", "false"); }
          }
          btn.classList.toggle("active");
          btn.setAttribute("aria-pressed", btn.classList.contains("active") ? "true" : "false");
        }
      });
    });
  }

  function getSelectedMods() {
    const mods = [];
    $qa("#mod-toggles .mod-toggle.active[data-mod]").forEach((b) => {
      if (b.dataset.mod !== "NM") mods.push(b.dataset.mod);
    });
    return mods;
  }

  window.saveSettings = function () {
    const body = {
      top_n: parseInt($("settings-top-n")?.value) || 20,
      poll_interval: parseInt($("settings-poll-interval")?.value) || 30,
      rec_count: parseInt($("settings-rec-count")?.value) || 12,
    };
    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          const ok = $("settings-save-ok");
          if (ok) { ok.classList.remove("hidden"); setTimeout(() => ok.classList.add("hidden"), 2000); }
          toast("Settings saved", "success");
        }
      })
      .catch(() => toast("Failed to save settings", "error"));
  };

  window.saveRecPrefs = function () {
    const mods = getSelectedMods();
    const useRecent = $("settings-use-recent")?.checked ?? true;
    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferred_mods: mods, use_recent_plays: useRecent }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          const ok = $("recprefs-save-ok");
          if (ok) { ok.classList.remove("hidden"); setTimeout(() => ok.classList.add("hidden"), 2000); }
          toast("Preferences saved", "success");
        }
      })
      .catch(() => toast("Failed to save preferences", "error"));
  };

  window.saveGlobalDifficulty = function () {
    const srMin = parseFloat($("global-sr-min")?.value) || null;
    const srMax = parseFloat($("global-sr-max")?.value) || null;
    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sr_min: srMin, sr_max: srMax }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          toast("Global difficulty filter applied", "success");
          if (meData) { meData.sr_min = srMin; meData.sr_max = srMax; }
        }
      })
      .catch(() => toast("Failed to save", "error"));
  };

  window.clearGlobalDifficulty = function () {
    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sr_min: null, sr_max: null }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          $("global-sr-min") && ($("global-sr-min").value = "");
          $("global-sr-max") && ($("global-sr-max").value = "");
          if (meData) { meData.sr_min = null; meData.sr_max = null; }
          toast("Global filter cleared", "success");
        }
      })
      .catch(() => toast("Failed to clear", "error"));
  };

  window.testCredentials = function () {
    const result = $("settings-test-result");
    const username = $("settings-username")?.value?.trim();
    const clientId = $("settings-client-id")?.value?.trim();
    const clientSecret = $("settings-client-secret")?.value?.trim();

    if (!username || !clientId) {
      if (result) { result.textContent = "Username and Client ID are required"; result.className = "test-result error"; result.classList.remove("hidden"); }
      return;
    }
    if (result) { result.textContent = "Testing..."; result.className = "test-result"; result.classList.remove("hidden"); }

    fetch("/api/test-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, client_id: clientId, client_secret: clientSecret || undefined }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          result.textContent = `Connected! Found ${data.user?.username || username}`;
          result.className = "test-result success";
        } else {
          result.textContent = `${data.error || "Failed"}`;
          result.className = "test-result error";
        }
        result.classList.remove("hidden");
      })
      .catch((err) => {
        result.textContent = `${err.message}`;
        result.className = "test-result error";
        result.classList.remove("hidden");
      });
  };

  window.saveActiveProfileCredentials = function () {
    const username = $("settings-username")?.value?.trim();
    const clientId = $("settings-client-id")?.value?.trim();
    const clientSecret = $("settings-client-secret")?.value?.trim();

    if (!meData?.active_id) {
      toast("No active profile", "error");
      return;
    }

    const body = { username };
    if (clientId) body.client_id = clientId;
    if (clientSecret) body.client_secret = clientSecret;

    fetch(`/api/profiles/${meData.active_id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok || data.id) {
          toast("Credentials saved", "success");
          loadMe();
        } else {
          toast(data.error || "Failed to save", "error");
        }
      })
      .catch(() => toast("Failed to save credentials", "error"));
  };

  /* ─── Export ────────────────────────────────────────────────── */

  window.exportRecs = function () {
    if (recsData.length === 0) { toast("No recommendations to export", "info"); return; }
    let text = "osu!helper Recommendations\n\n";
    recsData.forEach((r, i) => {
      const bms = r.beatmapset || {};
      const bm = r.beatmap || {};
      text += `${i + 1}. ${bms.artist} - ${bms.title} [${bm.version || ""}] (${(bm.difficulty_rating || 0).toFixed(2)})\n`;
      text += `   https://osu.ppy.sh/beatmapsets/${bms.id}#osu/${bm.id}\n\n`;
    });
    downloadText(text, "recommendations.txt");
  };

  window.exportLiked = function () {
    toast("Exporting liked maps...", "info");
    fetch("/api/feedback")
      .then((r) => r.json())
      .then((data) => {
        const entries = data.entries || [];
        if (entries.length === 0) { toast("No liked maps", "info"); return; }
        let text = "osu!helper Liked Maps\n\n";
        entries.forEach((e, i) => {
          text += `${i + 1}. ${e.title || "?"} (${(e.sr || 0).toFixed(2)})\n`;
          text += `   https://osu.ppy.sh/beatmapsets/${e.bms_id}\n\n`;
        });
        downloadText(text, "liked_maps.txt");
      })
      .catch(() => toast("Failed to export", "error"));
  };

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ─── Profile Management (Local Mode) ──────────────────────── */

  function loadProfilesList() {
    fetch("/api/profiles")
      .then((r) => r.json())
      .then((data) => {
        if (data.oauth_mode) return;
        const list = $("profiles-list");
        const menuList = $("profile-menu-list");
        if (!list) return;
        const profiles = data.profiles || [];
        const activeId = data.active_id;

        list.innerHTML = profiles
          .map(
            (p) => `
          <div class="profile-row ${p.id === activeId ? "active" : ""}">
            <div class="profile-row-info">
              <strong>${escHtml(p.display_name || p.username || "Unnamed")}</strong>
              <span class="profile-row-sub">${escHtml(p.username || "—")} ${p.pp ? `· ${Math.round(p.pp)}pp` : ""}</span>
            </div>
            <div class="profile-row-actions">
              ${p.id !== activeId ? `<button class="btn btn-ghost btn-xs" onclick="activateProfile('${p.id}')">Switch</button>` : '<span class="badge-active">Active</span>'}
              ${profiles.length > 1 ? `<button class="btn btn-ghost btn-xs btn-danger" onclick="deleteProfile('${p.id}')">Delete</button>` : ""}
            </div>
          </div>
        `
          )
          .join("");

        // Also update profile menu dropdown
        if (menuList) {
          menuList.innerHTML = profiles
            .map(
              (p) => `
            <button class="profile-menu-item ${p.id === activeId ? "active" : ""}" onclick="activateProfile('${p.id}')" role="menuitem">
              <span>${escHtml(p.display_name || p.username || "Unnamed")}</span>
              ${p.pp ? `<span class="profile-menu-pp">${Math.round(p.pp)}pp</span>` : ""}
            </button>
          `
            )
            .join("");
        }
      })
      .catch(() => {});
  }

  window.activateProfile = function (profileId) {
    fetch(`/api/profiles/${profileId}/activate`, { method: "POST" })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok || data.active_id) {
          toast("Profile switched", "success");
          playsData = [];
          recsData = [];
          likedTabLoaded = false;
          tasteTabLoaded = false;
          loadMe().then(() => {
            loadTopPlays();
            loadProfilesList();
          });
        }
      })
      .catch(() => toast("Failed to switch profile", "error"));
  };

  window.deleteProfile = function (profileId) {
    showConfirm("Delete this profile? This cannot be undone.", () => {
      fetch(`/api/profiles/${profileId}`, { method: "DELETE" })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) {
            toast("Profile deleted", "info");
            loadProfilesList();
            loadMe();
          }
        })
        .catch(() => toast("Failed to delete", "error"));
    });
  };

  window.toggleProfileMenu = function () {
    const menu = $("profile-menu");
    if (!menu) return;
    const isHidden = menu.classList.contains("hidden");
    menu.classList.toggle("hidden");
    $("profile-chip-btn")?.setAttribute("aria-expanded", isHidden ? "true" : "false");
    if (isHidden) {
      // Close on outside click
      setTimeout(() => {
        document.addEventListener("click", closeProfileMenuOutside, { once: true });
      }, 0);
    }
  };

  function closeProfileMenuOutside(e) {
    const menu = $("profile-menu");
    const chip = $("profile-chip-btn");
    if (menu && !menu.contains(e.target) && !chip?.contains(e.target)) {
      menu.classList.add("hidden");
      chip?.setAttribute("aria-expanded", "false");
    }
  }

  window.openAddProfile = function () {
    $("add-profile-modal")?.classList.remove("hidden");
    $("ap-error")?.classList.add("hidden");
    $("ap-username") && ($("ap-username").value = "");
    $("ap-display-name") && ($("ap-display-name").value = "");
    $("ap-client-id") && ($("ap-client-id").value = "");
    $("ap-client-secret") && ($("ap-client-secret").value = "");
  };

  window.closeAddProfile = function () {
    $("add-profile-modal")?.classList.add("hidden");
  };

  window.submitAddProfile = function () {
    const username = $("ap-username")?.value?.trim();
    const displayName = $("ap-display-name")?.value?.trim();
    const clientId = $("ap-client-id")?.value?.trim();
    const clientSecret = $("ap-client-secret")?.value?.trim();
    const error = $("ap-error");
    const spinner = $("ap-spinner");
    const btnText = $("ap-btn-text");

    if (!username || !clientId || !clientSecret) {
      if (error) { error.textContent = "Username, Client ID, and Client Secret are required."; error.classList.remove("hidden"); }
      return;
    }

    if (spinner) spinner.classList.remove("hidden");
    if (btnText) btnText.textContent = "Adding...";

    fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        display_name: displayName || username,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (spinner) spinner.classList.add("hidden");
        if (btnText) btnText.textContent = "Add Profile";
        if (data.error) {
          if (error) { error.textContent = data.error; error.classList.remove("hidden"); }
          return;
        }
        toast("Profile added!", "success");
        $("add-profile-modal")?.classList.add("hidden");
        loadProfilesList();
      })
      .catch((err) => {
        if (spinner) spinner.classList.add("hidden");
        if (btnText) btnText.textContent = "Add Profile";
        if (error) { error.textContent = err.message; error.classList.remove("hidden"); }
      });
  };

  /* ─── Confirm Dialog ────────────────────────────────────────── */

  function showConfirm(msg, onOk) {
    const modal = $("confirm-modal");
    const msgEl = $("confirm-modal-msg");
    const okBtn = $("confirm-ok-btn");
    const cancelBtn = $("confirm-cancel-btn");
    if (!modal) { if (confirm(msg)) onOk(); return; }
    if (msgEl) msgEl.textContent = msg;
    modal.classList.remove("hidden");
    const cleanup = () => modal.classList.add("hidden");
    okBtn.onclick = () => { cleanup(); onOk(); };
    cancelBtn.onclick = cleanup;
  }

  /* ─── History ───────────────────────────────────────────────── */

  window.loadHistory = function () {
    const list = $("history-list");
    if (!list) return;
    list.innerHTML = '<p style="font-size:.82rem;color:var(--text-muted)">Loading...</p>';
    fetch("/api/history")
      .then((r) => r.json())
      .then((data) => {
        const history = data.history || [];
        if (history.length === 0) {
          list.innerHTML = '<p style="font-size:.82rem;color:var(--text-muted)">No recommendation history yet.</p>';
          return;
        }
        list.innerHTML = history
          .map(
            (h) => `
          <div class="history-row">
            <span class="history-date">${h.date || "?"}</span>
            <span class="history-count">${(h.maps || []).length} maps</span>
            ${h.mod_filter?.length ? `<span class="history-mods">+${h.mod_filter.join("")}</span>` : ""}
          </div>
        `
          )
          .join("");
      })
      .catch(() => {
        list.innerHTML = '<p style="font-size:.82rem;color:var(--text-muted)">Failed to load history.</p>';
      });
  };

  /* ─── SSE (Server-Sent Events) ──────────────────────────────── */

  function startSSE() {
    if (window.OAUTH_MODE || _sseSource) return;
    _sseSource = new EventSource("/events");
    _sseSource.addEventListener("new_top_play", (e) => {
      try {
        const data = JSON.parse(e.data);
        showNewPlayBanner(data);
      } catch (err) {
        console.error("SSE parse error:", err);
      }
    });
    _sseSource.addEventListener("open", () => {
      const dot = $("live-dot");
      if (dot) dot.classList.remove("hidden");
    });
    _sseSource.onerror = () => {
      const dot = $("live-dot");
      if (dot) dot.classList.add("hidden");
    };
  }

  function showNewPlayBanner(data) {
    const banner = $("new-play-banner");
    const titleEl = $("new-play-title");
    if (!banner) return;
    if (titleEl) titleEl.textContent = data.title || "New top play detected!";
    banner.classList.remove("hidden");

    const viewBtn = $("new-play-view-btn");
    if (viewBtn) {
      viewBtn.onclick = () => {
        banner.classList.add("hidden");
        loadTopPlays();
        switchTab("plays");
      };
    }

    const closeBtn = $("new-play-close");
    if (closeBtn) {
      closeBtn.onclick = () => banner.classList.add("hidden");
    }

    // Auto-hide after 15s
    setTimeout(() => banner.classList.add("hidden"), 15000);
  }

  /* ─── Refresh Buttons ───────────────────────────────────────── */

  function setupRefreshButtons() {
    $("refresh-plays-btn")?.addEventListener("click", loadTopPlays);
    $("refresh-recs-btn")?.addEventListener("click", () => _loadRecommendations());
  }

  /* ─── User Info & Auth ──────────────────────────────────────── */

  function loadMe() {
    return fetch("/api/me")
      .then((r) => r.json())
      .then((data) => {
        meData = data;
        updateAuthUI(data);
        return data;
      })
      .catch((err) => {
        console.error("Failed to load /api/me:", err);
      });
  }

  function updateAuthUI(data) {
    if (data.oauth_mode) {
      if (!data.logged_in) {
        // Show login screen
        $("oauth-login-screen")?.classList.remove("hidden");
        return;
      }
      $("oauth-login-screen")?.classList.add("hidden");
      // Show OAuth user chip
      const chip = $("oauth-user-chip");
      if (chip) {
        chip.classList.remove("hidden");
        $("oauth-username") && ($("oauth-username").textContent = data.username || "—");
        $("oauth-pp") && ($("oauth-pp").textContent = data.pp ? `${Math.round(data.pp)}pp` : "—");
        const avatar = $("oauth-avatar");
        if (avatar && data.avatar_url) { avatar.src = data.avatar_url; avatar.style.display = ""; }
      }
      $("profile-switcher")?.classList.add("hidden");
    } else {
      // Local mode
      $("oauth-login-screen")?.classList.add("hidden");
      $("oauth-user-chip")?.classList.add("hidden");

      if (!data.logged_in || !data.has_credentials) {
        // Show setup overlay
        $("setup-overlay")?.classList.remove("hidden");
        return;
      }
      $("setup-overlay")?.classList.add("hidden");

      // Show profile switcher
      const switcher = $("profile-switcher");
      if (switcher) {
        switcher.classList.remove("hidden");
        $("profile-chip-name") && ($("profile-chip-name").textContent = data.display_name || data.username || "—");
        $("profile-chip-pp") && ($("profile-chip-pp").textContent = data.pp ? `${Math.round(data.pp)}pp` : "—");
        const avatar = $("profile-avatar");
        if (avatar && data.avatar_url) { avatar.src = data.avatar_url; avatar.style.display = ""; }
      }
    }

    // Fetch detailed user info to update avatar/pp
    loadUserInfo();
  }

  function loadUserInfo() {
    fetch("/api/user-info")
      .then((r) => r.json())
      .then((info) => {
        if (info.error) return;
        // Update header chips with fresh data
        if (meData?.oauth_mode) {
          const avatar = $("oauth-avatar");
          if (avatar && info.avatar_url) { avatar.src = info.avatar_url; avatar.style.display = ""; }
          $("oauth-pp") && ($("oauth-pp").textContent = info.pp ? `${Math.round(info.pp)}pp` : "—");
        } else {
          const avatar = $("profile-avatar");
          if (avatar && info.avatar_url) { avatar.src = info.avatar_url; avatar.style.display = ""; }
          $("profile-chip-pp") && ($("profile-chip-pp").textContent = info.pp ? `${Math.round(info.pp)}pp` : "—");
        }
      })
      .catch(() => {});
  }

  /* ─── Setup Overlay (First-time Local Mode) ─────────────────── */

  function setupSetupOverlay() {
    const btn = $("setup-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const username = $("setup-username")?.value?.trim();
      const clientId = $("setup-client-id")?.value?.trim();
      const clientSecret = $("setup-client-secret")?.value?.trim();
      const error = $("setup-error");
      const spinner = $("setup-spinner");
      const btnText = $("setup-btn-text");

      if (!username || !clientId || !clientSecret) {
        if (error) { error.textContent = "All fields are required."; error.classList.remove("hidden"); }
        return;
      }

      if (spinner) spinner.classList.remove("hidden");
      if (btnText) btnText.textContent = "Connecting...";
      if (error) error.classList.add("hidden");

      // Test credentials first, then save profile
      fetch("/api/test-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, client_id: clientId, client_secret: clientSecret }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (!data.ok) throw new Error(data.error || "Invalid credentials");
          // Update the default profile
          return fetch("/api/profiles")
            .then((r) => r.json())
            .then((pdata) => {
              if (pdata.oauth_mode) return;
              const profiles = pdata.profiles || [];
              if (profiles.length > 0) {
                return fetch(`/api/profiles/${profiles[0].id}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    username,
                    display_name: data.user?.username || username,
                    client_id: clientId,
                    client_secret: clientSecret,
                    avatar_url: data.user?.avatar_url || "",
                    pp: data.user?.pp,
                    global_rank: data.user?.global_rank,
                  }),
                });
              }
            });
        })
        .then(() => {
          if (spinner) spinner.classList.add("hidden");
          if (btnText) btnText.textContent = "Connect to osu!";
          $("setup-overlay")?.classList.add("hidden");
          toast("Connected to osu!", "success");
          loadMe().then(() => {
            loadTopPlays();
            startSSE();
          });
        })
        .catch((err) => {
          if (spinner) spinner.classList.add("hidden");
          if (btnText) btnText.textContent = "Connect to osu!";
          if (error) { error.textContent = err.message; error.classList.remove("hidden"); }
        });
    });
  }

  /* ─── Fetch initial dismissed/liked IDs ─────────────────────── */

  function loadDismissedAndLiked() {
    Promise.all([
      fetch("/api/dismissed").then((r) => r.json()),
      fetch("/api/feedback").then((r) => r.json()),
    ])
      .then(([dismissed, feedback]) => {
        dismissedIds = new Set(dismissed.dismissed || []);
        likedIds = new Set(feedback.liked || []);
      })
      .catch(() => {});
  }

  /* ─── Init ──────────────────────────────────────────────────── */

  function init() {
    initPlayer();
    setupTabs();
    setupViewToggle();
    setupRecModToggles();
    setupCatTabs();
    setupStatusFilter();
    setupExplore();
    setupModToggles();
    setupRefreshButtons();
    setupSetupOverlay();

    loadMe().then((data) => {
      if (!data) return;
      if (data.oauth_mode && !data.logged_in) return;
      if (!data.oauth_mode && !data.has_credentials) return;

      loadDismissedAndLiked();
      loadTopPlays();
      startSSE();
    });
  }

  // Boot
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
