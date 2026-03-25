"""
osu!helper — beatmap recommendation engine
Supports local multi-profile mode and hosted osu! OAuth mode.

Environment variables (hosted / Railway):
  OAUTH_MODE=1          — enable osu! OAuth login instead of manual API keys
  OSU_CLIENT_ID         — your osu! OAuth app client ID
  OSU_CLIENT_SECRET     — your osu! OAuth app client secret
  OSU_REDIRECT_URI      — e.g. https://yourapp.railway.app/auth/callback
  SECRET_KEY            — random secret for Flask sessions (generate one!)
  PORT                  — port to listen on (Railway sets this automatically)
"""

from flask import Flask, render_template, jsonify, request, Response, session, redirect
from werkzeug.middleware.proxy_fix import ProxyFix
import requests
import json
import time
import threading
import os
import sys
import statistics
import uuid
import secrets
import numpy as np
from datetime import datetime, timezone
from urllib.parse import urlencode

# ─────────────────────────────────────────────
# App setup — handle PyInstaller frozen mode
# ─────────────────────────────────────────────

if getattr(sys, "frozen", False):
    # Running as a PyInstaller bundle
    BASE_DIR = sys._MEIPASS
    DATA_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "osuhelper")
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    DATA_DIR = BASE_DIR

os.makedirs(DATA_DIR, exist_ok=True)

app = Flask(__name__,
            template_folder=os.path.join(BASE_DIR, "templates"),
            static_folder=os.path.join(BASE_DIR, "static"))
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))

CONFIG_FILE          = os.path.join(DATA_DIR, "config.json")
PROFILES_FILE        = os.path.join(DATA_DIR, "profiles.json")
DISMISSED_FILE       = os.path.join(DATA_DIR, "dismissed.json")
FEEDBACK_FILE        = os.path.join(DATA_DIR, "feedback.json")
BLOCKED_MAPPERS_FILE = os.path.join(DATA_DIR, "blocked_mappers.json")
HISTORY_FILE         = os.path.join(DATA_DIR, "rec_history.json")
SNAPSHOTS_FILE       = os.path.join(DATA_DIR, "taste_snapshots.json")
OSU_API_BASE    = "https://osu.ppy.sh/api/v2"
OSU_TOKEN_URL   = "https://osu.ppy.sh/oauth/token"
OSU_AUTH_URL    = "https://osu.ppy.sh/oauth/authorize"
NERINYAN_API    = "https://api.nerinyan.moe/search"

# Detect mode
OAUTH_MODE = os.environ.get("OAUTH_MODE", "").strip() in ("1", "true", "yes")

# Fix for Railway/nginx HTTPS reverse proxy — ensures url_for() and redirects use https://
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
# Secure session cookies so the OAuth state cookie survives the osu! redirect
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=OAUTH_MODE,   # Secure flag only when actually on HTTPS
    SESSION_COOKIE_HTTPONLY=True,
)

# ─────────────────────────────────────────────
# Config (local mode)
# ─────────────────────────────────────────────

DEFAULT_CONFIG = {
    "top_n":            20,
    "poll_interval":    30,
    "rec_count":        12,
    "sr_min":           None,   # hard floor on recommended difficulty (None = no limit)
    "sr_max":           None,   # hard ceiling on recommended difficulty (None = no limit)
    "preferred_mods":   [],     # [] = auto-detect from top plays; e.g. ["DT"] to override
    "use_recent_plays": True,   # blend recent activity into the taste profile
}


def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            cfg = json.load(f)
        for k, v in DEFAULT_CONFIG.items():
            cfg.setdefault(k, v)
        return cfg
    return dict(DEFAULT_CONFIG)


def save_config(cfg):
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)


# ─────────────────────────────────────────────
# Profiles (local mode)
# ─────────────────────────────────────────────

def load_profiles():
    """Load profiles.json, creating defaults from config.json if needed."""
    if os.path.exists(PROFILES_FILE):
        with open(PROFILES_FILE) as f:
            return json.load(f)

    # Bootstrap from legacy config.json
    cfg = {}
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            cfg = json.load(f)

    pid = str(uuid.uuid4())
    data = {
        "active_id": pid,
        "profiles": [
            {
                "id": pid,
                "username": cfg.get("username", ""),
                "display_name": cfg.get("username", "Profile 1"),
                "avatar_url": "",
                "pp": None,
                "global_rank": None,
                "client_id": cfg.get("client_id", ""),
                "client_secret": cfg.get("client_secret", ""),
            }
        ],
    }
    save_profiles(data)
    return data


def save_profiles(data):
    with open(PROFILES_FILE, "w") as f:
        json.dump(data, f, indent=2)


def get_active_profile():
    """Return the currently active profile dict (local mode only)."""
    data = load_profiles()
    active_id = data.get("active_id")
    for p in data.get("profiles", []):
        if p["id"] == active_id:
            return p
    # Fallback: first profile
    profs = data.get("profiles", [])
    return profs[0] if profs else {}


def get_profile_credentials():
    """Return (client_id, client_secret) for the active profile."""
    if OAUTH_MODE:
        return (
            os.environ.get("OSU_CLIENT_ID", ""),
            os.environ.get("OSU_CLIENT_SECRET", ""),
        )
    p = get_active_profile()
    return p.get("client_id", ""), p.get("client_secret", "")


# ─────────────────────────────────────────────
# osu! API token management
# ─────────────────────────────────────────────

_token_cache = {"access_token": None, "expires_at": 0}
_token_lock = threading.Lock()


def get_server_token(client_id=None, client_secret=None):
    """Client-credentials Bearer token for public API calls."""
    with _token_lock:
        cid, csec = client_id, client_secret
        if not cid or not csec:
            cid, csec = get_profile_credentials()
        if not cid or not csec:
            raise ValueError("osu! API credentials not configured.")

        now = time.time()
        if _token_cache["access_token"] and now < _token_cache["expires_at"] - 60:
            return _token_cache["access_token"]

        resp = requests.post(
            OSU_TOKEN_URL,
            json={
                "client_id": int(cid),
                "client_secret": csec,
                "grant_type": "client_credentials",
                "scope": "public",
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        _token_cache["access_token"] = data["access_token"]
        _token_cache["expires_at"] = now + data["expires_in"]
        return _token_cache["access_token"]


def osu_get(path, params=None, token=None):
    if token is None:
        token = get_server_token()
    resp = requests.get(
        f"{OSU_API_BASE}{path}",
        headers={"Authorization": f"Bearer {token}"},
        params=params or {},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


# ─────────────────────────────────────────────
# osu! OAuth (hosted mode)
# ─────────────────────────────────────────────

def get_oauth_login_url():
    """Build the osu! OAuth authorization URL."""
    state = secrets.token_urlsafe(16)
    params = {
        "client_id": os.environ.get("OSU_CLIENT_ID", ""),
        "redirect_uri": os.environ.get("OSU_REDIRECT_URI", ""),
        "response_type": "code",
        "scope": "identify",
        "state": state,
    }
    return OSU_AUTH_URL + "?" + urlencode(params), state


def exchange_code_for_token(code):
    """Exchange an OAuth authorization code for an access token."""
    resp = requests.post(
        OSU_TOKEN_URL,
        json={
            "client_id": int(os.environ.get("OSU_CLIENT_ID", 0)),
            "client_secret": os.environ.get("OSU_CLIENT_SECRET", ""),
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": os.environ.get("OSU_REDIRECT_URI", ""),
        },
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_me(user_token):
    """Fetch the authenticated user's own profile using their token."""
    resp = requests.get(
        f"{OSU_API_BASE}/me/osu",
        headers={"Authorization": f"Bearer {user_token}"},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


# ─────────────────────────────────────────────
# Top plays
# ─────────────────────────────────────────────

def get_user_id(username):
    data = osu_get(f"/users/{username}", {"key": "username"})
    return data["id"]


def fetch_top_plays(username, limit=100):
    uid = get_user_id(username)
    return osu_get(f"/users/{uid}/scores/best", {"mode": "osu", "limit": limit})


def fetch_recent_plays(username, limit=30):
    """Fetch the player's most recent submitted plays (passes only)."""
    uid = get_user_id(username)
    return osu_get(f"/users/{uid}/scores/recent",
                   {"mode": "osu", "limit": limit, "include_fails": "0"})


# ── Dismissed beatmapset persistence ─────────────────────────────────────────

def _load_dismissed_raw():
    """
    Load dismissed.json handling both formats:
      old: [id1, id2, ...]
      new: {"ids": [...], "entries": [...]}
    Returns the dict in new format.
    """
    if os.path.exists(DISMISSED_FILE):
        try:
            with open(DISMISSED_FILE) as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                return raw
            # Migrate flat list → new format (no vectors for old entries)
            return {"ids": sorted(int(x) for x in raw), "entries": []}
        except Exception:
            pass
    return {"ids": [], "entries": []}


def load_dismissed():
    """Return the set of dismissed beatmapset IDs."""
    return set(int(x) for x in _load_dismissed_raw().get("ids", []))


def save_dismissed(ids: set):
    """Persist dismissed IDs, preserving existing vector entries."""
    data = _load_dismissed_raw()
    data["ids"] = sorted(ids)
    # Prune vector entries for IDs that were un-dismissed
    data["entries"] = [e for e in data.get("entries", []) if e.get("bms_id") in ids]
    with open(DISMISSED_FILE, "w") as f:
        json.dump(data, f, indent=2)


def load_dismissed_vecs():
    """Return the list of dismissed-map vector entries (for dislike penalty)."""
    return _load_dismissed_raw().get("entries", [])


# ── Feedback (liked maps) persistence ────────────────────────────────────────

def load_feedback():
    """Return the feedback dict: {"liked": [...]}"""
    if os.path.exists(FEEDBACK_FILE):
        try:
            with open(FEEDBACK_FILE) as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {"liked": []}


def save_feedback(data: dict):
    with open(FEEDBACK_FILE, "w") as f:
        json.dump(data, f, indent=2)


def load_blocked_mappers() -> set:
    """Return the set of blocked mapper names (lowercase)."""
    if os.path.exists(BLOCKED_MAPPERS_FILE):
        try:
            with open(BLOCKED_MAPPERS_FILE) as f:
                data = json.load(f)
            if isinstance(data, list):
                return set(s.lower().strip() for s in data)
        except Exception:
            pass
    return set()


def save_blocked_mappers(names: set):
    with open(BLOCKED_MAPPERS_FILE, "w") as f:
        json.dump(sorted(names), f, indent=2)


def load_history() -> list:
    """Return the recommendation history list (most recent first, capped at 50)."""
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE) as f:
                data = json.load(f)
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def save_history(entries: list):
    with open(HISTORY_FILE, "w") as f:
        json.dump(entries[:50], f, indent=2)


def load_snapshots() -> list:
    if os.path.exists(SNAPSHOTS_FILE):
        try:
            with open(SNAPSHOTS_FILE) as f:
                data = json.load(f)
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def save_snapshot(sr: float, ar: float, bpm: float, dominant_mods: list):
    """Save a daily taste snapshot (one per day, newer overwrites same-day entry)."""
    today = datetime.now(timezone.utc).date().isoformat()
    snaps = load_snapshots()
    # Remove existing entry for today if present
    snaps = [s for s in snaps if s.get("date") != today]
    snaps.insert(0, {
        "date":          today,
        "sr":            round(sr, 2),
        "ar":            round(ar, 2),
        "bpm":           round(bpm, 1),
        "dominant_mods": dominant_mods,
    })
    # Keep last 180 days
    snaps = snaps[:180]
    with open(SNAPSHOTS_FILE, "w") as f:
        json.dump(snaps, f, indent=2)


def append_history(recs: list, mod_filter=None):
    """Append a new history entry from a recommendation result set."""
    if not recs:
        return
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "count": len(recs),
        "mod_filter": mod_filter or [],
        "maps": [
            {
                "title":   (r.get("beatmapset") or {}).get("title", "?"),
                "creator": (r.get("beatmapset") or {}).get("creator", ""),
                "sr":      (r.get("beatmap") or {}).get("difficulty_rating"),
                "bms_id":  (r.get("beatmapset") or {}).get("id"),
                "bm_id":   (r.get("beatmap") or {}).get("id"),
                "category": r.get("category", "best_match"),
            }
            for r in recs[:6]
        ],
    }
    history = load_history()
    history.insert(0, entry)
    save_history(history)


def current_username():
    """Return the active username — from session (OAuth) or active profile (local)."""
    if OAUTH_MODE:
        return session.get("osu_username", "")
    return get_active_profile().get("username", "")


# ─────────────────────────────────────────────
# Map type classifier
# ─────────────────────────────────────────────

MAP_TYPE_INFO = {
    "streams":       {"label": "Streams",       "color": "#ff5555"},
    "aim":           {"label": "Aim",            "color": "#8be9fd"},
    "tech":          {"label": "Tech",           "color": "#bd93f9"},
    "reading":       {"label": "Reading",        "color": "#f1fa8c"},
    "finger control":{"label": "Finger Control", "color": "#ffb86c"},
    "speed":         {"label": "Speed",          "color": "#ff79c6"},
    "farm":          {"label": "Farm",           "color": "#50fa7b"},
    "misc":          {"label": "Misc",           "color": "#888899"},
}


def classify_map_type(bm, bms=None):
    """
    Classify a beatmap into one or two type labels.
    Uses attribute heuristics first, then cross-references mapper-supplied
    beatmap tags to catch types the heuristic may miss (e.g. 'alt', 'tech').
    """
    bms = bms or {}
    bpm     = float(bm.get("bpm") or bms.get("bpm") or 0)
    ar      = float(bm.get("ar") or 0)
    od      = float(bm.get("accuracy") or 0)   # OD field
    sr      = float(bm.get("difficulty_rating") or 0)
    circles = int(bm.get("count_circles") or 0)
    sliders = int(bm.get("count_sliders") or 0)
    total   = max(circles + sliders, 1)
    circ_r  = circles / total
    density = _note_density(bm)   # circles per second — key stream signal

    types = []
    # Streams: high BPM + circle-heavy + must actually have dense circles (>=4/sec)
    if bpm >= 170 and circ_r >= 0.55 and sr >= 4.0 and density >= 4.0:
        types.append("streams")
    # Aim: high AR, high SR, moderate+ BPM — large jumpy patterns
    if ar >= 9.5 and sr >= 5.5 and bpm >= 130 and "streams" not in types:
        types.append("aim")
    # Reading: low AR makes patterns hard to read regardless of other stats
    if ar <= 8.5 and sr >= 3.5:
        types.append("reading")
    # Tech: mid BPM, high OD, slider-heavy (low circle ratio), complex patterns
    if 120 <= bpm <= 215 and od >= 8.5 and circ_r < 0.65 and sr >= 5.0 and "streams" not in types:
        types.append("tech")
    # Finger control: slow BPM but hard — sliders/bursts demand control
    if bpm < 160 and sr >= 5.5 and circ_r < 0.5:
        types.append("finger control")
    # Speed: very fast BPM but not circle-dense enough to be full streams
    if bpm >= 220 and circ_r < 0.6 and "streams" not in types:
        types.append("speed")

    # ── Tag-based supplement ──────────────────────────────────────────────────
    # Mapper tags are the ground-truth labels for style; if a tag directly names
    # a type and the heuristic missed it, inject it at the front of the list.
    _TAG_TYPE_MAP = {
        "stream":        "streams",
        "streams":       "streams",
        "streaming":     "streams",
        "aim":           "aim",
        "jump":          "aim",
        "jumps":         "aim",
        "tech":          "tech",
        "technical":     "tech",
        "farm":          "farm",
        "farmable":      "farm",
        "alt":           "finger control",
        "alternate":     "finger control",
        "alternating":   "finger control",
        "speed":         "speed",
        "reading":       "reading",
        "lowAR":         "reading",
    }
    tags = set((bms.get("tags") or "").lower().split())
    for tag in tags:
        tag_type = _TAG_TYPE_MAP.get(tag)
        if tag_type and tag_type not in types:
            types.insert(0, tag_type)   # tag evidence is strong — push to front
            break

    return types[:2] if types else ["misc"]


# ─────────────────────────────────────────────
# AI recommendation engine
# ─────────────────────────────────────────────

# Feature vector layout: [sr, ar, od, cs, bpm, length, note_density, combo_ratio]
# note_density   = circles/drain_time  — how "streamy" a map is
# combo_ratio    = max_combo/(circles+sliders) — proxy for average slider length;
#                  circle-only maps ≈1, long-slider maps can be 3-4+
_FEAT_W = np.array([3.0, 1.8, 0.8, 0.5, 1.2, 0.3, 2.0, 0.6], dtype=float)


def _note_density(bm):
    """Circles per second — key stream/aim discriminator."""
    circles = int(bm.get("count_circles") or 0)
    drain   = max(float(bm.get("drain") or bm.get("total_length") or 60), 1)
    return circles / drain


def _combo_ratio(bm):
    """
    max_combo / (circles + sliders) — approximates average slider length.
    Each circle contributes 1 combo; sliders contribute head + ticks + tail,
    so maps with long sliders have a higher ratio than short-slider/circle maps.
    Capped at 4 for normalisation (most maps fall well under that).
    """
    circles  = int(bm.get("count_circles") or 0)
    sliders  = int(bm.get("count_sliders") or 0)
    objects  = circles + sliders
    if objects == 0:
        return 0.5   # sensible default
    max_combo = int(bm.get("max_combo") or objects)   # fallback: assume 1/obj
    return min(max_combo / objects, 4.0) / 4.0        # normalise to [0, 1]


def _bm_to_vec(bm, bms=None, mods=None):
    """
    Normalise a beatmap's attributes into an 8-dim feature vector.
    When `mods` is provided the speed/AR/OD adjustments from DT/HT/HR/EZ are
    applied so the vector reflects what the player actually experienced.
    """
    bms = bms or {}

    if mods:
        bpm, ar, od, cs, sr = _apply_mods(bm, bms, mods)
    else:
        bpm = float(bm.get("bpm") or bms.get("bpm") or 180)
        ar  = float(bm.get("ar", 9))
        od  = float(bm.get("accuracy", 8))
        cs  = float(bm.get("cs", 4))
        sr  = float(bm.get("difficulty_rating", 5))

    density = min(_note_density(bm), 15) / 15.0   # cap at 15 circles/sec
    return np.array([
        sr / 10.0,
        ar / 11.0,
        od / 10.0,
        cs / 10.0,
        min(bpm, 400)                         / 400.0,
        min(float(bm.get("total_length", 120)), 600) / 600.0,
        density,
        _combo_ratio(bm),
    ], dtype=float)


def _cosine(a, b):
    n = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b)) / n if n > 0 else 0.0


# ── Mod adjustment helpers ──────────────────────────────────────────────────

def _ar_to_ms(ar):
    """AR → preempt window in ms (used for DT/HT/HR/EZ adjustment)."""
    return 1800 - 120 * ar if ar <= 5 else 1200 - 150 * (ar - 5)


def _ms_to_ar(ms):
    """Preempt window in ms → AR."""
    return (1800 - ms) / 120 if ms >= 1200 else 5 + (1200 - ms) / 150


def _od_to_ms(od):
    """OD → 300-hit window in ms."""
    return 80 - 6 * od


def _ms_to_od(ms):
    """300-hit window in ms → OD."""
    return (80 - ms) / 6


def _apply_mods(bm, bms, mods):
    """
    Return mod-adjusted (bpm, ar, od, cs, sr) for a beatmap + mods list.
    mods may be a list of strings like ["HD","DT"] or dicts {"acronym":"DT"}.
    Order: HR/EZ applied first (stat multipliers), then DT/HT (speed change).
    """
    bpm = float(bm.get("bpm") or bms.get("bpm") or 180)
    ar  = float(bm.get("ar", 9))
    od  = float(bm.get("accuracy", 8))
    cs  = float(bm.get("cs", 4))
    sr  = float(bm.get("difficulty_rating", 5))

    # Normalise mod list to uppercase acronym strings
    acronyms = set()
    for m in (mods or []):
        if isinstance(m, str):
            acronyms.add(m.upper())
        elif isinstance(m, dict):
            acronyms.add(m.get("acronym", "").upper())

    # HR: CS ×1.3 (cap 10), AR ×1.4 (cap 10), OD ×1.4 (cap 10)
    if "HR" in acronyms:
        cs = min(cs * 1.3, 10.0)
        ar = min(ar * 1.4, 10.0)
        od = min(od * 1.4, 10.0)

    # EZ: all stats ×0.5
    if "EZ" in acronyms:
        cs = cs * 0.5
        ar = ar * 0.5
        od = od * 0.5

    # DT / NC: speed ×1.5 → adjust AR and OD through their ms windows
    if "DT" in acronyms or "NC" in acronyms:
        bpm = bpm * 1.5
        ar  = _ms_to_ar(_ar_to_ms(ar) / 1.5)
        od  = _ms_to_od(_od_to_ms(od) / 1.5)
        sr  = sr * 1.35   # rough approximation; actual SR varies by map

    # HT: speed ×0.75
    if "HT" in acronyms:
        bpm = bpm * 0.75
        ar  = _ms_to_ar(_ar_to_ms(ar) / 0.75)
        od  = _ms_to_od(_od_to_ms(od) / 0.75)
        sr  = sr * 0.88

    return bpm, min(ar, 11.0), min(od, 11.0), min(cs, 10.0), sr


# ── Mod preference helpers ───────────────────────────────────────────────────

_SKILL_MODS = {"DT", "NC", "HT", "HR", "EZ"}  # mods that change difficulty stats

def _normalise_acronyms(mods):
    """Return a set of uppercase acronym strings from any mod list format."""
    out = set()
    for m in (mods or []):
        if isinstance(m, str):
            out.add(m.upper())
        elif isinstance(m, dict):
            out.add(m.get("acronym", "").upper())
    return out


def _detect_preferred_mods(plays, top_n=20):
    """
    Detect which skill-affecting mods (DT/HR/HT/EZ) this player uses most,
    weighted by the pp of each play.

    Returns:
        mod_weights  — {acronym: normalised_weight} for mods used on >20% of
                       weighted plays (e.g. {"DT": 0.85, "HR": 0.30})
        dominant_combo — the single highest-weighted mod combo as a list of
                         acronym strings (e.g. ["DT"] or ["DT", "HR"])
    """
    acronym_w = {}
    combo_w   = {}
    total_pp  = 0.0

    for play in plays[:top_n]:
        pp      = float(play.get("pp") or 1)
        acronyms = _normalise_acronyms(play.get("mods", []))
        skill    = tuple(sorted(acronyms & _SKILL_MODS))

        combo_w[skill]  = combo_w.get(skill, 0.0)  + pp
        for a in skill:
            acronym_w[a] = acronym_w.get(a, 0.0) + pp
        total_pp += pp

    if not total_pp:
        return {}, []

    norm_w         = {k: v / total_pp for k, v in acronym_w.items()}
    significant    = {k: v for k, v in norm_w.items() if v > 0.20}
    dominant_combo = list(max(combo_w, key=combo_w.get)) if combo_w else []
    # Drop empty tuple → empty list when NM is the dominant combo
    dominant_combo = [a for a in dominant_combo if a in _SKILL_MODS]
    return significant, dominant_combo


def _reverse_mod_params(ar_adj, bpm_adj, sr_adj, dominant_combo):
    """
    Given mod-ADJUSTED AR/BPM/SR values (as stored in the taste vector) and the
    dominant mod combo used to produce them, return the equivalent BASE map stats.

    This is used so nerinyan/osu! searches are issued in base-stat space — the
    space the API actually indexes — rather than in the player's experienced space.

    Example: a DT player's taste vector may encode AR 10.5 and BPM 270.
    Reversing DT gives AR ~9 and BPM 180, which is what we actually want to
    search for.
    """
    ar  = float(ar_adj)
    bpm = float(bpm_adj)
    sr  = float(sr_adj)
    acronyms = {a.upper() for a in dominant_combo}

    # Reverse DT / NC  (speed ×1.5)
    if "DT" in acronyms or "NC" in acronyms:
        bpm = bpm / 1.5
        ar  = _ms_to_ar(_ar_to_ms(ar) * 1.5)   # undo the preempt compression
        sr  = sr / 1.35

    # Reverse HT  (speed ×0.75)
    if "HT" in acronyms:
        bpm = bpm / 0.75
        ar  = _ms_to_ar(_ar_to_ms(ar) * 0.75)
        sr  = sr / 0.88

    # Reverse HR  (AR ×1.4)
    if "HR" in acronyms:
        ar = ar / 1.4

    # Reverse EZ  (AR ×0.5)
    if "EZ" in acronyms:
        ar = ar / 0.5

    return max(ar, 0.0), max(bpm, 1.0), max(sr, 0.5)


def _build_user_context(plays, top_n=20):
    """
    Return (taste_vec, mapper_weights, tag_weights, type_weights) from top plays.

    Weighting scheme: pp × accuracy × time_decay
      • pp       — higher-pp plays are more representative of skill ceiling
      • accuracy — a 99% on a 300pp map is more informative than a 92% FC on
                   a 500pp play with a lucky run
      • time_decay — plays from 2+ years ago reflect a different skill level;
                     weight decays with a ~180-day half-life so recent form
                     dominates without completely ignoring history

    Also uses mod-adjusted feature vectors (DT/HT/HR/EZ) so the taste profile
    reflects what the player actually experienced, not the raw map stats.
    """
    slice_ = plays[:top_n]
    if not slice_:
        return None, {}, {}, {}

    vecs, weights = [], []
    mapper_raw, type_raw = {}, {}
    now_ts = time.time()

    for play in slice_:
        bm   = play.get("beatmap", {})
        bms  = play.get("beatmapset", {})
        pp   = float(play.get("pp") or 1)
        acc  = float(play.get("accuracy") or 1.0)   # 0–1 float from API
        mods = play.get("mods", [])

        # Time decay: half-life of 180 days
        time_weight = 1.0
        created_at  = play.get("created_at", "")
        if created_at:
            try:
                play_ts    = datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
                days_ago   = max(0.0, (now_ts - play_ts) / 86400)
                time_weight = 0.5 ** (days_ago / 180)
            except Exception:
                time_weight = 1.0

        combined_w = pp * acc * time_weight

        vecs.append(_bm_to_vec(bm, bms, mods))   # mod-adjusted vector
        weights.append(combined_w)

        creator = (bms.get("creator") or "").lower().strip()
        if creator:
            mapper_raw[creator] = mapper_raw.get(creator, 0) + combined_w

        for t in classify_map_type(bm, bms):
            type_raw[t] = type_raw.get(t, 0) + combined_w

    vecs_np    = np.array(vecs)
    weights_np = np.array(weights)
    weights_np = weights_np / weights_np.sum()
    taste_vec  = np.average(vecs_np, axis=0, weights=weights_np)

    def _normalise(d):
        mx = max(d.values()) if d else 1
        return {k: v / mx for k, v in d.items()}

    # tag_w is intentionally empty — we match on beatmap tags at search time,
    # not on accumulated user-history tags.
    return taste_vec, _normalise(mapper_raw), {}, _normalise(type_raw)


def _build_liked_context(liked_list):
    """
    Convert the raw liked-map list from feedback.json into a list of dicts
    suitable for use in _ai_score.  Each dict has:
      "vec"        — raw 8-dim feature vector (NOT yet weighted by _FEAT_W)
      "creator"    — lowercase mapper name
      "map_types"  — list of type strings from classify_map_type
    """
    if not liked_list:
        return []
    result = []
    for entry in liked_list:
        raw_vec = entry.get("vec")
        if raw_vec is None:
            continue
        try:
            result.append({
                "vec":       np.array(raw_vec, dtype=float),
                "creator":   (entry.get("creator") or "").lower().strip(),
                "map_types": entry.get("map_types") or [],
            })
        except Exception:
            pass
    return result


def _build_disliked_context(dismissed_entries):
    """
    Convert dismissed vector entries into the same format as liked_vecs so
    _ai_score can apply a penalty to candidates that resemble dismissed maps.
    """
    if not dismissed_entries:
        return []
    result = []
    for entry in dismissed_entries:
        raw_vec = entry.get("vec")
        if raw_vec is None:
            continue
        try:
            result.append({
                "vec":       np.array(raw_vec, dtype=float),
                "creator":   (entry.get("creator") or "").lower().strip(),
                "map_types": entry.get("map_types") or [],
            })
        except Exception:
            pass
    return result


def _ai_score(bm, bms, taste_vec, mapper_w, tag_w, type_w,
              pp_target=None, preferred_mods=None, liked_vecs=None, disliked_vecs=None):
    """
    Score a candidate map (higher = better match). Returns (score, reason_str).

    preferred_mods  — list of mod acronym strings (e.g. ["DT", "HR"]).  When
                      provided the candidate map's feature vector is computed
                      *with those mods applied*, placing it in the same
                      experiential space as the taste vector (which was built
                      from mod-adjusted plays).  This is critical for DT/HR
                      players — without it, cosine similarity is distorted.

    pp_target       — PP value the player needs to beat to improve their profile.
    """
    # Compute candidate vector in the same mod space as the taste vector.
    vec      = _bm_to_vec(bm, bms, preferred_mods or []) * _FEAT_W
    tvec     = taste_vec * _FEAT_W
    cos_sim  = _cosine(vec, tvec)          # 0-1
    score    = cos_sim * 100               # base 0-100

    reasons  = []

    # ── Attribute-based reason labels ──────
    sr      = float(bm.get("difficulty_rating", 0))
    ar      = float(bm.get("ar", 0))
    bpm     = float(bm.get("bpm") or bms.get("bpm") or 0)
    t_sr    = float(taste_vec[0] * 10)
    t_ar    = float(taste_vec[1] * 11)
    t_bpm   = float(taste_vec[4] * 400)

    density   = _note_density(bm)
    t_density = float(taste_vec[6] * 15)

    if abs(sr - t_sr) < 0.3:   reasons.append(f"very similar difficulty ({sr:.1f}★)")
    elif abs(sr - t_sr) < 0.6: reasons.append(f"close difficulty ({sr:.1f}★)")
    if abs(ar - t_ar) < 0.5:   reasons.append(f"same AR ({ar:.1f})")
    if t_bpm > 0 and abs(bpm - t_bpm) / t_bpm < 0.1:
        reasons.append(f"similar BPM ({bpm:.0f})")
    if t_density > 1 and abs(density - t_density) / max(t_density, 1) < 0.2:
        reasons.append(f"similar note density ({density:.1f}/s)")

    # ── Mapper bonus (max +8) ───────────────
    creator = (bms.get("creator") or "").lower().strip()
    if creator and creator in mapper_w:
        bonus = mapper_w[creator] * 8
        score += bonus
        reasons.append(f"by a mapper you like ({bms.get('creator','')})")

    # ── Map-type preference bonus (max +20) ─
    # Most reliable style signal — a stream player should always get stream maps.
    bm_types = classify_map_type(bm, bms)
    for t in bm_types:
        if t in type_w:
            score += type_w[t] * 20
            break  # only count once

    # ── Beatmap tag overlap bonus (max +10) ─
    # Compares the candidate's tags against the target beatmap's tags.
    # Only meaningful in single-play mode (tag_w is empty for profile recs).
    bm_tags = set((bms.get("tags") or "").lower().split())
    if bm_tags and tag_w:
        target_tags = set(t for t in tag_w if len(t) > 3)
        overlap = len(bm_tags & target_tags)
        if overlap:
            score += min(overlap / max(len(target_tags), 1), 1.0) * 10
            reasons.append("matching map style tags")

    # ── PP-improvement bonus (max +12) ──────
    # Favour maps estimated to be in the player's farmable PP zone — i.e. the
    # range where successfully playing a map would push their total PP up.
    # The SR→PP formula below is a rough approximation; it's directionally
    # correct for NM plays on maps in the 4–9★ range.
    if pp_target is not None and pp_target > 0 and sr >= 2.0:
        est_pp = 45.0 * (sr ** 2.6)   # order-of-magnitude estimate
        ratio  = abs(est_pp - pp_target) / max(pp_target, 1)
        if ratio < 0.20:
            score += 12
            reasons.append("great PP farm potential")
        elif ratio < 0.40:
            score += 6
            reasons.append("decent PP farm potential")

    # ── Recency bonus (max +6) ───────────────
    # Slightly prefer maps that are freshly ranked so the list doesn't feel stale.
    ranked_date = bms.get("ranked_date") or bms.get("submitted_date") or ""
    if ranked_date:
        try:
            rd_ts    = datetime.fromisoformat(str(ranked_date).replace("Z", "+00:00")).timestamp()
            days_old = max(0.0, (time.time() - rd_ts) / 86400)
            if days_old < 365:          # ranked within a year
                score += 6
                reasons.append("recently ranked")
            elif days_old < 548:        # ~18 months
                score += 3
        except Exception:
            pass

    # ── Mod compatibility note ───────────────
    # If the player has a dominant mod combo, note when the map pairs especially
    # well with it (e.g. DT on an AR9 map lifts it to the player's preferred AR).
    if preferred_mods:
        acronyms = {a.upper() for a in preferred_mods}
        ar_base  = float(bm.get("ar", 0))
        bpm_base = float(bm.get("bpm") or bms.get("bpm") or 0)
        if ("DT" in acronyms or "NC" in acronyms):
            ar_dt = _ms_to_ar(_ar_to_ms(ar_base) / 1.5)
            if 9.5 <= ar_dt <= 11.0:
                reasons.append(f"great DT AR ({ar_dt:.1f} with DT)")
        if "HR" in acronyms and ar_base <= 9.0:
            reasons.append("suitable base AR for HR")

    # ── Liked-map similarity bonus (max +15) ─
    # If the player has explicitly liked maps, boost candidates that are
    # cosine-similar to those liked maps.  We average similarity across all
    # liked entries so a single unusual like doesn't dominate the ranking.
    if liked_vecs:
        sims = []
        for lv in liked_vecs:
            lv_w = lv["vec"] * _FEAT_W
            sims.append(_cosine(vec, lv_w))
        avg_sim = sum(sims) / len(sims)
        if avg_sim > 0.90:
            score += 15
            reasons.append("very similar to maps you liked")
        elif avg_sim > 0.75:
            score += 10
            reasons.append("similar to maps you liked")
        elif avg_sim > 0.60:
            score += 5
            reasons.append("loosely similar to maps you liked")

    # ── Disliked-map similarity penalty (max -8) ─
    # Penalise candidates that resemble maps the player has dismissed, so the
    # algorithm actively steers away from content they've shown they don't want.
    if disliked_vecs:
        sims = []
        for dv in disliked_vecs:
            dv_w = dv["vec"] * _FEAT_W
            sims.append(_cosine(vec, dv_w))
        avg_dsim = sum(sims) / len(sims)
        if avg_dsim > 0.90:
            score -= 8
        elif avg_dsim > 0.75:
            score -= 5
        elif avg_dsim > 0.60:
            score -= 2

    # ── Minimum quality filter ───────────────
    # Maps with very few plays are likely obscure or low-effort; dampen them.
    playcount = int(bm.get("playcount") or 0)
    if playcount < 100:
        score *= 0.60
    elif playcount < 500:
        score *= 0.85

    # ── Pass-rate penalty ────────────────────
    passcount = int(bm.get("passcount") or 0)
    if playcount >= 200:
        pass_rate = passcount / playcount
        if pass_rate < 0.05:      # < 5% — extremely brutal
            score *= 0.70
        elif pass_rate < 0.15:    # 5–15% — noticeably punishing
            score *= 0.87

    if not reasons:
        reasons.append(f"{sr:.1f}★, AR{ar:.1f}")

    return score, " · ".join(reasons)


def _build_target_context(play):
    """Build a single-play context for 'similar to this map' mode."""
    bm   = play.get("beatmap", {})
    bms  = play.get("beatmapset", {})
    mods = play.get("mods", [])
    # Use mod-adjusted vector so the search centre reflects the actual
    # AR/BPM the player experienced (important for DT players especially).
    vec = _bm_to_vec(bm, bms, mods)
    # Mapper and tag weights heavily skewed toward the specific map
    creator = (bms.get("creator") or "").lower().strip()
    mapper_w = {creator: 1.0} if creator else {}
    tag_w    = {t: 1.0 for t in (bms.get("tags") or "").lower().split() if len(t) > 2}
    type_w   = {t: 1.0 for t in classify_map_type(bm, bms)}
    return vec, mapper_w, tag_w, type_w


def _pack_bms(bms):
    return {
        "id": bms.get("id"), "title": bms.get("title",""),
        "artist": bms.get("artist",""), "creator": bms.get("creator",""),
        "covers": bms.get("covers",{}), "ranked": bms.get("ranked"),
        "status": bms.get("status",""), "bpm": bms.get("bpm"),
        "tags": bms.get("tags",""),
        "ranked_date": bms.get("ranked_date") or bms.get("submitted_date") or "",
    }

def _pack_bm(bm, bms):
    return {
        "id": bm.get("id"), "version": bm.get("version",""),
        "difficulty_rating": bm.get("difficulty_rating",0),
        "ar": bm.get("ar",0), "accuracy": bm.get("accuracy",0),
        "cs": bm.get("cs",0), "drain": bm.get("drain",0),
        "bpm": bm.get("bpm") or bms.get("bpm"), "total_length": bm.get("total_length",0),
        "count_circles": bm.get("count_circles",0),
        "count_sliders": bm.get("count_sliders",0),
        "max_combo":     bm.get("max_combo", 0),
        "passcount":     bm.get("passcount", 0),
        "playcount":     bm.get("playcount", 0),
        "url": bm.get("url", f"https://osu.ppy.sh/b/{bm.get('id')}"),
        "map_types": classify_map_type(bm, bms),
    }


def _query_nerinyan(taste_vec, mapper_w, tag_w, type_w, played_bm_ids, played_bms_ids,
                    rec_count=12, sr_center=5.0, ar_center=9.0, bpm_center=180,
                    search_tags=None, pp_target=None, preferred_mods=None,
                    sr_min=None, sr_max=None, liked_vecs=None, disliked_vecs=None,
                    blocked_mappers=None):
    # Build the base query; wider windows give more candidates for the scorer to
    # rank rather than returning too few results because the range is too tight.
    diff_lo = max(sr_center - 1.3, sr_min if sr_min is not None else 0)
    diff_hi = min(sr_center + 1.3, sr_max if sr_max is not None else 99)
    if diff_lo >= diff_hi:   # config limits make this band impossible — skip
        return []
    params = {
        "m": 0, "r": "1,2,4",
        "diff": f"{diff_lo:.1f}-{diff_hi:.1f}",
        "ar":   f"{max(0, ar_center-1.5):.1f}-{min(11, ar_center+1.5):.1f}",
        "bpm":  f"{bpm_center*0.75:.0f}-{bpm_center*1.25:.0f}",
        "p": 0, "ps": 100,
    }
    # If we have explicit beatmap tags to guide the search, include them.
    if search_tags:
        params["q"] = " ".join(search_tags[:5])

    all_beatmapsets = []
    try:
        resp = requests.get(NERINYAN_API, params=params, timeout=10)
        if resp.ok:
            data = resp.json()
            if isinstance(data, list):
                all_beatmapsets.extend(data)
    except Exception:
        pass

    # Second pass without tag constraint if the first returned too few results.
    if search_tags and len(all_beatmapsets) < rec_count * 2:
        try:
            params_fallback = {k: v for k, v in params.items() if k != "q"}
            resp2 = requests.get(NERINYAN_API, params=params_fallback, timeout=10)
            if resp2.ok:
                data2 = resp2.json()
                if isinstance(data2, list):
                    existing_ids = {b.get("id") for b in all_beatmapsets}
                    all_beatmapsets.extend(b for b in data2 if b.get("id") not in existing_ids)
        except Exception:
            pass

    _blocked = blocked_mappers or set()
    results = []
    for bms in all_beatmapsets:
        if not isinstance(bms, dict): continue
        if bms.get("id") in played_bms_ids: continue
        if (bms.get("creator") or "").lower().strip() in _blocked: continue
        for bm in bms.get("beatmaps", []):
            mode_int = bm.get("mode_int", bm.get("mode"))
            if mode_int != 0 and bm.get("mode") not in ("osu", "osu!"): continue
            if bm.get("id") in played_bm_ids: continue
            bm["bpm"] = bm.get("bpm") or bms.get("bpm", bpm_center)
            score, reason = _ai_score(bm, bms, taste_vec, mapper_w, tag_w, type_w,
                                      pp_target=pp_target,
                                      preferred_mods=preferred_mods,
                                      liked_vecs=liked_vecs,
                                      disliked_vecs=disliked_vecs)
            results.append({
                "beatmapset":   _pack_bms(bms),
                "beatmap":      _pack_bm(bm, bms),
                "score":        score,
                "reason":       reason,
                "source":       "nerinyan",
                "suggested_mods": preferred_mods or [],
            })

    results.sort(key=lambda x: x["score"], reverse=True)
    seen, out = set(), []
    for r in results:
        bid = r["beatmapset"]["id"]
        if bid not in seen:
            seen.add(bid); out.append(r)
    return out[:rec_count]


def _query_osu_search(taste_vec, mapper_w, tag_w, type_w, played_bms_ids,
                      rec_count=8, sr_center=5.0, pp_target=None, preferred_mods=None,
                      liked_vecs=None, disliked_vecs=None, blocked_mappers=None):
    """
    Fallback search via the osu! API.  Uses the player's dominant map type
    as the search keyword so the results are style-relevant, not just popular.
    """
    _TYPE_QUERIES = {
        "streams":        "streams",
        "aim":            "aim jumps",
        "tech":           "tech",
        "finger control": "alternate alt",
        "speed":          "speed",
        "reading":        "reading",
        "farm":           "farm",
    }
    dominant_type = max(type_w, key=type_w.get) if type_w else None
    q = _TYPE_QUERIES.get(dominant_type, "") if dominant_type else ""

    try:
        data = osu_get("/beatmapsets/search", {"m":0,"s":"ranked","sort":"plays_desc","q":q})
        beatmapsets = data.get("beatmapsets", [])
    except Exception:
        return []
    _blocked = blocked_mappers or set()
    results = []
    for bms in beatmapsets:
        if bms.get("id") in played_bms_ids: continue
        if (bms.get("creator") or "").lower().strip() in _blocked: continue
        for bm in bms.get("beatmaps", []):
            if bm.get("mode") != "osu": continue
            if abs(bm.get("difficulty_rating",0) - sr_center) > 1.5: continue
            bm["bpm"] = bm.get("bpm") or bms.get("bpm", 180)
            score, reason = _ai_score(bm, bms, taste_vec, mapper_w, tag_w, type_w,
                                      pp_target=pp_target,
                                      preferred_mods=preferred_mods,
                                      liked_vecs=liked_vecs,
                                      disliked_vecs=disliked_vecs)
            results.append({
                "beatmapset":   _pack_bms(bms),
                "beatmap":      _pack_bm(bm, bms),
                "score":        score,
                "reason":       reason,
                "source":       "osu",
                "suggested_mods": preferred_mods or [],
            })
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:rec_count]


def _diversify(recs, rec_count, max_per_mapper=2):
    """
    Re-order a ranked recommendation list to enforce variety:
      - At most max_per_mapper maps from the same mapper appear in the final list.
      - Surplus maps are moved to an overflow pool and back-filled only if
        there aren't enough diverse alternatives to fill rec_count slots.

    Score ordering is preserved within each group so the best map from each
    mapper always appears before the second-best from the same mapper.
    """
    mapper_counts = {}
    out, overflow = [], []
    for r in recs:
        creator = (r.get("beatmapset") or {}).get("creator", "").lower().strip()
        mapper_counts[creator] = mapper_counts.get(creator, 0) + 1
        if mapper_counts[creator] <= max_per_mapper:
            out.append(r)
        else:
            overflow.append(r)

    # Back-fill with overflow if we're short
    for r in overflow:
        if len(out) >= rec_count:
            break
        out.append(r)

    return out[:rec_count]


def _top_beatmap_tags(plays, n=5, top_n=20):
    """
    Extract the most representative beatmap tags from a slice of top plays.
    Filters out very short tokens and common noise words so only meaningful
    style/genre keywords reach the nerinyan search query.
    """
    _NOISE = {
        "the", "and", "for", "feat", "ver", "mix", "short", "full", "long",
        "remix", "edit", "size", "with", "from", "original", "version",
    }
    counts = {}
    for play in plays[:top_n]:
        bms = play.get("beatmapset", {})
        for tag in (bms.get("tags") or "").lower().split():
            if len(tag) > 3 and tag not in _NOISE:
                counts[tag] = counts.get(tag, 0) + 1
    # Return tags that appear in at least 2 plays so single-map noise is filtered
    frequent = [t for t, c in counts.items() if c >= 2]
    frequent.sort(key=lambda t: -counts[t])
    return frequent[:n]


def _assign_category(r, sr_c):
    """
    Assign a recommendation category based on SR offset and reason text.
    Categories: 'best_match' | 'pp_farm' | 'comfort' | 'challenge' | 'just_ranked'
    """
    sr = (r.get("beatmap") or {}).get("difficulty_rating", sr_c)
    reason = (r.get("reason") or "").lower()
    ranked_str = (r.get("beatmapset") or {}).get("ranked_date") or ""
    try:
        ranked_days = (datetime.now(timezone.utc) - datetime.fromisoformat(
            ranked_str.replace("Z", "+00:00"))).days
    except Exception:
        ranked_days = 9999
    if ranked_days < 60:
        return "just_ranked"
    if "pp" in reason and sr >= sr_c:
        return "pp_farm"
    if sr < sr_c - 0.3:
        return "comfort"
    if sr > sr_c + 0.4:
        return "challenge"
    return "best_match"


def get_recommendations_for_profile(top_plays, cfg, recent_plays=None, mod_filter=None):
    top_n     = cfg.get("top_n", 20)
    rec_count = cfg.get("rec_count", 12)
    sr_min    = cfg.get("sr_min")   # None or float
    sr_max    = cfg.get("sr_max")   # None or float
    # Manual mod override: if non-empty, use instead of auto-detected combo
    manual_mods = cfg.get("preferred_mods") or []

    played_bm_ids  = {p["beatmap"]["id"] for p in top_plays if p.get("beatmap")}
    played_bms_ids = {p["beatmap"]["beatmapset_id"] for p in top_plays if p.get("beatmap")}

    # ── Mod filter: restrict taste profile to plays with specific mods ────────
    # Plays are filtered but the full played_bm/bms_ids stay so we don't
    # recommend maps the player has already set a score on regardless of mod.
    if mod_filter:
        mod_filter_set = {m.upper() for m in _normalise_acronyms(mod_filter)}
        filtered_plays = [
            p for p in top_plays
            if mod_filter_set & _normalise_acronyms(p.get("mods", []))
        ]
        # Fall back to all plays if the filter yields too few
        profile_plays = filtered_plays if len(filtered_plays) >= 5 else top_plays
    else:
        profile_plays = top_plays

    # ── Recent plays context blending ────────────────────────────────────────
    # Blend recent plays into the working play list (deduplicated) so that
    # whatever the player has been doing lately also influences the taste vector.
    if recent_plays and cfg.get("use_recent_plays", True):
        recent_bm_ids = {p["beatmap"]["id"] for p in recent_plays if p.get("beatmap")}
        played_bm_ids |= recent_bm_ids
        played_bms_ids |= {p["beatmap"]["beatmapset_id"]
                           for p in recent_plays if p.get("beatmap")}
        # Append recent plays that aren't already in profile_plays (avoid duplicates
        # by best_id so the same play isn't counted twice)
        top_best_ids = {p.get("best_id") for p in profile_plays}
        extra = [p for p in recent_plays if p.get("best_id") not in top_best_ids]
        blended_plays = profile_plays + extra
    else:
        blended_plays = profile_plays

    taste_vec, mapper_w, tag_w, type_w = _build_user_context(blended_plays, top_n)
    if taste_vec is None:
        return []

    # ── Mod detection / override ──────────────────────────────────────────────
    # If the user has set a manual mod override use that; otherwise auto-detect.
    if manual_mods:
        dominant_combo = [m for m in _normalise_acronyms(manual_mods) if m in _SKILL_MODS]
    elif mod_filter:
        dominant_combo = [m for m in _normalise_acronyms(mod_filter) if m in _SKILL_MODS]
    else:
        _, dominant_combo = _detect_preferred_mods(profile_plays, top_n)

    sr_adj  = float(taste_vec[0] * 10)
    ar_adj  = float(taste_vec[1] * 11)
    bpm_adj = float(taste_vec[4] * 400)

    ar_c, bpm_c, sr_c = _reverse_mod_params(ar_adj, bpm_adj, sr_adj, dominant_combo)

    # Apply hard SR clamp from user config
    if sr_min is not None:
        sr_c = max(sr_c, float(sr_min))
    if sr_max is not None:
        sr_c = min(sr_c, float(sr_max))

    # PP threshold: the PP of the player's weakest top-100 play.
    pps = sorted([float(p.get("pp") or 0) for p in profile_plays if p.get("pp")], reverse=True)
    pp_target = pps[min(len(pps) - 1, 99)] if pps else None

    # Recurring beatmap tags used as a nerinyan search hint
    search_tags = _top_beatmap_tags(profile_plays, n=5, top_n=top_n) or None

    # ── Load dismissed beatmapset IDs & vectors ───────────────────────────────
    dismissed_ids   = load_dismissed()
    disliked_vecs   = _build_disliked_context(load_dismissed_vecs())

    # ── Load liked-map context ────────────────────────────────────────────────
    feedback_data = load_feedback()
    liked_vecs    = _build_liked_context(feedback_data.get("liked", []))

    # ── Load blocked mappers ──────────────────────────────────────────────────
    blocked_mappers = load_blocked_mappers()

    # ── Multi-pass: comfort / current / challenge ─────────────────────────────
    # Band offset → base category: deterministic so every band fills its tab.
    # Within the main band (offset 0) we still check for just_ranked / pp_farm.
    _BAND_CATS = {-0.5: "comfort", 0.0: "best_match", 0.7: "challenge"}
    all_recs = []
    seen_ids = set()
    for sr_offset, base_cat in _BAND_CATS.items():
        sr_band = sr_c + sr_offset
        if sr_band < 1.0:
            continue
        band_recs = _query_nerinyan(
            taste_vec, mapper_w, tag_w, type_w,
            played_bm_ids, played_bms_ids, rec_count,
            sr_band, ar_c, bpm_c,
            search_tags=search_tags,
            pp_target=pp_target,
            preferred_mods=dominant_combo,
            sr_min=sr_min,
            sr_max=sr_max,
            liked_vecs=liked_vecs,
            disliked_vecs=disliked_vecs,
            blocked_mappers=blocked_mappers,
        )
        for r in band_recs:
            bid = r["beatmapset"]["id"]
            if bid not in seen_ids and bid not in dismissed_ids:
                seen_ids.add(bid)
                # Refine the base category for just_ranked / pp_farm signals
                cat = base_cat
                ranked_str = (r.get("beatmapset") or {}).get("ranked_date") or ""
                if ranked_str:
                    try:
                        ranked_days = (datetime.now(timezone.utc) -
                                       datetime.fromisoformat(
                                           ranked_str.replace("Z", "+00:00"))).days
                        if ranked_days < 60:
                            cat = "just_ranked"
                    except Exception:
                        pass
                if cat == base_cat and base_cat in ("best_match", "comfort") and \
                        "pp" in (r.get("reason") or "").lower():
                    cat = "pp_farm"
                r["category"] = cat
                all_recs.append(r)

    all_recs.sort(key=lambda x: x["score"], reverse=True)

    # ── Skill-gap pass ────────────────────────────────────────────────────────
    # Detect which learnable map type is most underrepresented in the player's
    # taste profile and fetch a small batch of maps specifically for that gap.
    _LEARNABLE_TYPES = ["streams", "aim", "tech", "reading", "finger control", "speed"]
    gap_type = None
    gap_score = 1.0  # lowest weight wins
    for t in _LEARNABLE_TYPES:
        w = type_w.get(t, 0.0)
        if w < gap_score:
            gap_score = w
            gap_type  = t
    if gap_type and gap_score < 0.25:
        _TYPE_TAGS = {
            "streams":        ["streams", "stream"],
            "aim":            ["aim", "jumps"],
            "tech":           ["tech", "technical"],
            "reading":        ["reading", "lowAR"],
            "finger control": ["alternate", "alt"],
            "speed":          ["speed"],
        }
        gap_tags = _TYPE_TAGS.get(gap_type, [gap_type])
        gap_recs = _query_nerinyan(
            taste_vec, mapper_w, {}, {gap_type: 1.0},
            played_bm_ids, played_bms_ids, max(3, rec_count // 4),
            sr_c, ar_c, bpm_c,
            search_tags=gap_tags,
            pp_target=pp_target,
            preferred_mods=dominant_combo,
            sr_min=sr_min, sr_max=sr_max,
            liked_vecs=liked_vecs, disliked_vecs=disliked_vecs,
            blocked_mappers=blocked_mappers,
        )
        for r in gap_recs:
            bid = r["beatmapset"]["id"]
            if bid not in seen_ids and bid not in dismissed_ids:
                seen_ids.add(bid)
                r["category"]   = "skill_gap"
                r["gap_type"]   = gap_type
                r["reason"]     = f"expand your {gap_type} skills · " + (r.get("reason") or "")
                all_recs.append(r)

    if len(all_recs) < rec_count // 2:
        fallback = _query_osu_search(
            taste_vec, mapper_w, tag_w, type_w,
            played_bms_ids, rec_count - len(all_recs), sr_c,
            pp_target=pp_target,
            preferred_mods=dominant_combo,
            liked_vecs=liked_vecs,
            disliked_vecs=disliked_vecs,
            blocked_mappers=blocked_mappers,
        )
        for r in fallback:
            bid = r["beatmapset"]["id"]
            if bid not in seen_ids and bid not in dismissed_ids:
                seen_ids.add(bid)
                cat = "best_match"
                ranked_str = (r.get("beatmapset") or {}).get("ranked_date") or ""
                if ranked_str:
                    try:
                        ranked_days = (datetime.now(timezone.utc) -
                                       datetime.fromisoformat(
                                           ranked_str.replace("Z", "+00:00"))).days
                        if ranked_days < 60:
                            cat = "just_ranked"
                    except Exception:
                        pass
                if cat == "best_match" and "pp" in (r.get("reason") or "").lower():
                    cat = "pp_farm"
                r["category"] = cat
                all_recs.append(r)

    return _diversify(all_recs, rec_count)


def get_recommendations_for_play(play, top_plays, cfg):
    rec_count      = cfg.get("rec_count", 12)
    played_bm_ids  = {p["beatmap"]["id"] for p in top_plays if p.get("beatmap")}
    played_bms_ids = {p["beatmap"]["beatmapset_id"] for p in top_plays if p.get("beatmap")}

    taste_vec, mapper_w, tag_w, type_w = _build_target_context(play)
    bm   = play.get("beatmap", {})
    bms  = play.get("beatmapset", {})
    mods = play.get("mods", [])

    # The play's mods are the preferred mods for single-play recommendations.
    play_mods    = [a for a in _normalise_acronyms(mods) if a in _SKILL_MODS]
    # Reverse mod adjustments so nerinyan gets base stats to search against.
    ar_adj  = float(bm.get("ar", 9))
    bpm_adj = float(bm.get("bpm") or bms.get("bpm") or 180)
    sr_adj  = float(bm.get("difficulty_rating", 5))
    # The taste vector for a single play IS the mod-adjusted version; the raw
    # bm stats are the BASE stats, so we use those directly for search center.
    ar_c  = ar_adj
    bpm_c = bpm_adj
    sr_c  = sr_adj

    # Use the source beatmap's own tags to guide the nerinyan search.
    _NOISE = {"the","and","for","feat","ver","mix","short","full","long","remix","edit"}
    raw_tags = [t for t in (bms.get("tags") or "").lower().split()
                if len(t) > 3 and t not in _NOISE]
    search_tags = raw_tags[:5] if raw_tags else None

    dismissed_ids   = load_dismissed()
    disliked_vecs   = _build_disliked_context(load_dismissed_vecs())
    feedback_data   = load_feedback()
    liked_vecs      = _build_liked_context(feedback_data.get("liked", []))
    blocked_mappers = load_blocked_mappers()

    recs = _query_nerinyan(taste_vec, mapper_w, tag_w, type_w,
                           played_bm_ids, played_bms_ids, rec_count,
                           sr_c, ar_c, bpm_c,
                           search_tags=search_tags,
                           preferred_mods=play_mods,
                           liked_vecs=liked_vecs,
                           disliked_vecs=disliked_vecs,
                           blocked_mappers=blocked_mappers)
    recs = [r for r in recs if r["beatmapset"]["id"] not in dismissed_ids]
    for r in recs:
        r.setdefault("category", "best_match")

    if len(recs) < rec_count // 2:
        seen_ids = {r["beatmapset"]["id"] for r in recs}
        fallback = _query_osu_search(taste_vec, mapper_w, tag_w, type_w,
                                     played_bms_ids, rec_count - len(recs), sr_c,
                                     preferred_mods=play_mods,
                                     liked_vecs=liked_vecs,
                                     disliked_vecs=disliked_vecs,
                                     blocked_mappers=blocked_mappers)
        for r in fallback:
            bid = r["beatmapset"]["id"]
            if bid not in seen_ids and bid not in dismissed_ids:
                r.setdefault("category", "best_match")
                recs.append(r)

    return _diversify(recs, rec_count)


# ─────────────────────────────────────────────
# Live polling (local mode only)
# ─────────────────────────────────────────────

_poll_state = {
    "top_plays": [], "last_top_ids": [],
    "new_play_queue": [], "lock": threading.Lock(), "running": False,
}

# Per-user plays cache for OAuth mode  {username: {"plays": [...], "cached_at": float}}
_user_plays_cache: dict = {}
_user_plays_lock  = threading.Lock()
_USER_PLAYS_TTL   = 300  # 5 minutes


def _get_user_plays(username: str):
    """Return cached plays for a user. Returns [] if stale/missing."""
    if not OAUTH_MODE:
        with _poll_state["lock"]:
            return list(_poll_state["top_plays"])
    with _user_plays_lock:
        entry = _user_plays_cache.get(username)
        if entry and time.time() - entry["cached_at"] < _USER_PLAYS_TTL:
            return entry["plays"]
    return []


def _set_user_plays(username: str, plays: list):
    """Store plays for a user and seed the local poll state when in local mode."""
    if not OAUTH_MODE:
        with _poll_state["lock"]:
            _poll_state["top_plays"] = plays
    else:
        with _user_plays_lock:
            _user_plays_cache[username] = {"plays": plays, "cached_at": time.time()}


def _serialize_play(play):
    bm  = play.get("beatmap", {})
    bms = play.get("beatmapset", {})
    return {
        "best_id": play.get("best_id"), "pp": play.get("pp"),
        "accuracy": play.get("accuracy"), "rank": play.get("rank"),
        "mods": play.get("mods", []), "max_combo": play.get("max_combo"),
        "created_at": play.get("created_at"),
        "beatmap": {
            "id": bm.get("id"), "beatmapset_id": bm.get("beatmapset_id"),
            "difficulty_rating": bm.get("difficulty_rating"), "version": bm.get("version"),
            "ar": bm.get("ar"), "accuracy": bm.get("accuracy"),
            "cs": bm.get("cs"), "drain": bm.get("drain"),
            "bpm": bm.get("bpm"), "total_length": bm.get("total_length"),
            "count_circles": bm.get("count_circles", 0),
            "count_sliders": bm.get("count_sliders", 0),
            "url": bm.get("url"),
            "map_types": classify_map_type(bm, bms),
        },
        "beatmapset": {
            "id": bms.get("id"), "title": bms.get("title"),
            "artist": bms.get("artist"), "creator": bms.get("creator"),
            "covers": bms.get("covers", {}), "bpm": bms.get("bpm"),
            "tags": bms.get("tags", ""),
        },
    }


def _polling_loop():
    while True:
        cfg = load_config()
        interval = cfg.get("poll_interval", 30)
        username = current_username() if not OAUTH_MODE else ""

        if username:
            try:
                plays = fetch_top_plays(username)
                top_n = cfg.get("top_n", 20)
                with _poll_state["lock"]:
                    old_ids    = set(_poll_state["last_top_ids"])
                    new_top_ids = [p["best_id"] for p in plays[:top_n]]
                    newly_in   = [p for p in plays[:top_n] if p["best_id"] not in old_ids]
                    if old_ids and newly_in:
                        for new_play in newly_in:
                            recs = get_recommendations_for_play(new_play, plays, cfg)
                            _poll_state["new_play_queue"].append({
                                "play": _serialize_play(new_play),
                                "recommendations": recs,
                                "timestamp": datetime.now(timezone.utc).isoformat(),
                            })
                    _poll_state["top_plays"]    = plays
                    _poll_state["last_top_ids"] = new_top_ids
            except Exception as e:
                print(f"[poll] error: {e}")

        time.sleep(interval)


def _start_polling():
    if not _poll_state["running"]:
        _poll_state["running"] = True
        threading.Thread(target=_polling_loop, daemon=True).start()


# ─────────────────────────────────────────────
# Auth routes (OAuth / hosted mode)
# ─────────────────────────────────────────────

@app.route("/auth/login")
def auth_login():
    url, state = get_oauth_login_url()
    session["oauth_state"] = state
    return redirect(url)


@app.route("/auth/callback")
def auth_callback():
    error = request.args.get("error")
    if error:
        return redirect("/?auth_error=" + error)

    code  = request.args.get("code", "")
    state = request.args.get("state", "")
    if state != session.get("oauth_state", ""):
        return redirect("/?auth_error=state_mismatch")

    try:
        token_data  = exchange_code_for_token(code)
        user_token  = token_data["access_token"]
        me          = fetch_me(user_token)

        session["osu_user_id"]   = me["id"]
        session["osu_username"]  = me["username"]
        session["osu_avatar"]    = me.get("avatar_url", "")
        session["osu_pp"]        = me.get("statistics", {}).get("pp")
        session["osu_rank"]      = me.get("statistics", {}).get("global_rank")
    except Exception as e:
        return redirect(f"/?auth_error={str(e)[:80]}")

    return redirect("/")


@app.route("/auth/logout")
def auth_logout():
    session.clear()
    return redirect("/")


# ─────────────────────────────────────────────
# Profile API routes (local mode)
# ─────────────────────────────────────────────

@app.route("/api/profiles", methods=["GET"])
def api_profiles_get():
    if OAUTH_MODE:
        return jsonify({"oauth_mode": True})
    data = load_profiles()
    # Redact secrets before sending
    safe_profiles = []
    for p in data.get("profiles", []):
        sp = dict(p)
        if sp.get("client_secret"):
            sp["client_secret"] = "••••••••"
        safe_profiles.append(sp)
    return jsonify({"active_id": data.get("active_id"), "profiles": safe_profiles})


@app.route("/api/profiles", methods=["POST"])
def api_profiles_create():
    if OAUTH_MODE:
        return jsonify({"error": "not available in OAuth mode"}), 400
    body = request.get_json(force=True)
    data = load_profiles()
    pid  = str(uuid.uuid4())
    new_profile = {
        "id":           pid,
        "username":     body.get("username", ""),
        "display_name": body.get("display_name") or body.get("username", "New Profile"),
        "avatar_url":   "",
        "pp":           None,
        "global_rank":  None,
        "client_id":    body.get("client_id", ""),
        "client_secret": body.get("client_secret", ""),
    }
    data["profiles"].append(new_profile)
    # If it's the first profile, make it active
    if len(data["profiles"]) == 1:
        data["active_id"] = pid
    save_profiles(data)
    sp = dict(new_profile)
    sp["client_secret"] = "••••••••" if sp.get("client_secret") else ""
    return jsonify({"ok": True, "profile": sp})


@app.route("/api/profiles/<profile_id>", methods=["PUT"])
def api_profiles_update(profile_id):
    if OAUTH_MODE:
        return jsonify({"error": "not available in OAuth mode"}), 400
    body = request.get_json(force=True)
    data = load_profiles()
    for p in data["profiles"]:
        if p["id"] == profile_id:
            for key in ("username", "display_name", "client_id"):
                if key in body:
                    p[key] = body[key]
            if body.get("client_secret") and body["client_secret"] != "••••••••":
                p["client_secret"] = body["client_secret"]
            # Update cached user info if provided
            for key in ("avatar_url", "pp", "global_rank"):
                if key in body and body[key] is not None:
                    p[key] = body[key]
            save_profiles(data)
            # Bust token cache if credentials changed
            if "client_id" in body or "client_secret" in body:
                _bust_token_cache()
            return jsonify({"ok": True})
    return jsonify({"error": "Profile not found"}), 404


@app.route("/api/profiles/<profile_id>", methods=["DELETE"])
def api_profiles_delete(profile_id):
    if OAUTH_MODE:
        return jsonify({"error": "not available in OAuth mode"}), 400
    data = load_profiles()
    data["profiles"] = [p for p in data["profiles"] if p["id"] != profile_id]
    if data.get("active_id") == profile_id:
        data["active_id"] = data["profiles"][0]["id"] if data["profiles"] else None
    save_profiles(data)
    return jsonify({"ok": True})


@app.route("/api/profiles/<profile_id>/activate", methods=["POST"])
def api_profiles_activate(profile_id):
    if OAUTH_MODE:
        return jsonify({"error": "not available in OAuth mode"}), 400
    data = load_profiles()
    ids  = [p["id"] for p in data["profiles"]]
    if profile_id not in ids:
        return jsonify({"error": "Profile not found"}), 404
    data["active_id"] = profile_id
    save_profiles(data)
    # Reset polling state for new profile
    with _poll_state["lock"]:
        _poll_state["top_plays"]    = []
        _poll_state["last_top_ids"] = []
    _bust_token_cache()
    return jsonify({"ok": True})


def _bust_token_cache():
    global _token_cache
    _token_cache = {"access_token": None, "expires_at": 0}


# ─────────────────────────────────────────────
# Core API routes
# ─────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html", oauth_mode=OAUTH_MODE)


@app.route("/api/me")
def api_me():
    """Returns the current user's identity (both modes)."""
    cfg = load_config()
    extra = {
        "sr_min":           cfg.get("sr_min"),
        "sr_max":           cfg.get("sr_max"),
        "preferred_mods":   cfg.get("preferred_mods", []),
        "use_recent_plays": cfg.get("use_recent_plays", True),
    }
    if OAUTH_MODE:
        if "osu_username" not in session:
            return jsonify({"logged_in": False, "oauth_mode": True})
        return jsonify({
            "logged_in":     True,
            "oauth_mode":    True,
            "username":      session.get("osu_username"),
            "user_id":       session.get("osu_user_id"),
            "avatar_url":    session.get("osu_avatar"),
            "pp":            session.get("osu_pp"),
            "global_rank":   session.get("osu_rank"),
            "top_n":         cfg.get("top_n", 20),
            "poll_interval": cfg.get("poll_interval", 30),
            "rec_count":     cfg.get("rec_count", 12),
            **extra,
        })
    else:
        p = get_active_profile()
        return jsonify({
            "logged_in":   bool(p.get("username")),
            "oauth_mode":  False,
            "username":    p.get("username", ""),
            "display_name": p.get("display_name", ""),
            "avatar_url":  p.get("avatar_url", ""),
            "pp":          p.get("pp"),
            "global_rank": p.get("global_rank"),
            "active_id":   load_profiles().get("active_id"),
            "top_n":       cfg.get("top_n", 20),
            "poll_interval": cfg.get("poll_interval", 30),
            "rec_count":   cfg.get("rec_count", 12),
            "has_credentials": bool(p.get("client_id") and p.get("client_secret")),
            **extra,
        })


@app.route("/api/config", methods=["POST"])
def api_config_post():
    """Save global settings."""
    body = request.get_json(force=True)
    cfg  = load_config()
    for key in ("top_n", "poll_interval", "rec_count"):
        if key in body:
            cfg[key] = body[key]
    # New user-control fields
    if "sr_min" in body:
        v = body["sr_min"]
        cfg["sr_min"] = float(v) if v not in (None, "", "null") else None
    if "sr_max" in body:
        v = body["sr_max"]
        cfg["sr_max"] = float(v) if v not in (None, "", "null") else None
    if "preferred_mods" in body:
        mods = body["preferred_mods"]
        cfg["preferred_mods"] = [m for m in (_normalise_acronyms(mods) if isinstance(mods, list) else []) if m in _SKILL_MODS]
    if "use_recent_plays" in body:
        cfg["use_recent_plays"] = bool(body["use_recent_plays"])
    save_config(cfg)
    return jsonify({"ok": True})


@app.route("/api/test-credentials", methods=["POST"])
def api_test_credentials():
    body = request.get_json(force=True)
    cid  = body.get("client_id", "")
    csec = body.get("client_secret", "")
    username = body.get("username", "")
    try:
        token = get_server_token(cid, csec)
        resp  = requests.get(
            f"{OSU_API_BASE}/users/{username}",
            headers={"Authorization": f"Bearer {token}"},
            params={"mode": "osu", "key": "username"},
            timeout=10,
        )
        resp.raise_for_status()
        ud = resp.json()
        return jsonify({
            "ok": True,
            "user": {
                "id":          ud.get("id"),
                "username":    ud.get("username"),
                "avatar_url":  ud.get("avatar_url"),
                "pp":          ud.get("statistics", {}).get("pp"),
                "global_rank": ud.get("statistics", {}).get("global_rank"),
                "country":     ud.get("country", {}).get("name"),
                "country_code": ud.get("country_code"),
            },
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/api/top-plays")
def api_top_plays():
    username = current_username()
    if not username:
        return jsonify({"error": "Not logged in"}), 401
    try:
        plays = fetch_top_plays(username, 100)
        serialized = [_serialize_play(p) for p in plays]
        cfg = load_config()
        _set_user_plays(username, plays)
        if not OAUTH_MODE:
            with _poll_state["lock"]:
                if not _poll_state["last_top_ids"]:
                    _poll_state["last_top_ids"] = [p["best_id"] for p in plays[:cfg.get("top_n", 20)]]
        return jsonify({"plays": serialized})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/user-info")
def api_user_info():
    username = current_username()
    if not username:
        return jsonify({"error": "Not logged in"}), 401
    try:
        ud = osu_get(f"/users/{username}", {"key": "username"})
        info = {
            "id":          ud.get("id"),
            "username":    ud.get("username"),
            "avatar_url":  ud.get("avatar_url"),
            "cover_url":   ud.get("cover_url"),
            "pp":          ud.get("statistics", {}).get("pp"),
            "global_rank": ud.get("statistics", {}).get("global_rank"),
            "country_rank": ud.get("statistics", {}).get("country_rank"),
            "country":     ud.get("country", {}).get("name"),
            "country_code": ud.get("country_code"),
            "play_count":  ud.get("statistics", {}).get("play_count"),
        }
        # Cache in profile (local mode)
        if not OAUTH_MODE:
            pdata = load_profiles()
            active_id = pdata.get("active_id")
            for p in pdata["profiles"]:
                if p["id"] == active_id:
                    p["avatar_url"]  = info["avatar_url"] or ""
                    p["pp"]          = info["pp"]
                    p["global_rank"] = info["global_rank"]
            save_profiles(pdata)
        return jsonify(info)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/recommendations")
def api_recommendations():
    username = current_username()
    if not username:
        return jsonify({"error": "Not logged in"}), 401
    cfg = load_config()
    # Optional mod filter: comma-separated acronyms, e.g. ?mod_filter=DT,HR
    raw_mod_filter = request.args.get("mod_filter", "").strip()
    mod_filter = [m.strip().upper() for m in raw_mod_filter.split(",") if m.strip()] or None
    try:
        plays = _get_user_plays(username)
        if not plays:
            plays = fetch_top_plays(username, 100)
            _set_user_plays(username, plays)
        # Optionally blend recent plays for fresh context
        recent_plays = None
        if cfg.get("use_recent_plays", True):
            try:
                recent_plays = fetch_recent_plays(username, limit=30)
            except Exception:
                recent_plays = None
        recs = get_recommendations_for_profile(plays, cfg, recent_plays=recent_plays,
                                               mod_filter=mod_filter)
        append_history(recs, mod_filter=mod_filter)
        return jsonify({"recommendations": recs, "mod_filter": mod_filter or []})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────
# Dismissed beatmapsets API
# ─────────────────────────────────────────────

@app.route("/api/dismissed", methods=["GET"])
def api_dismissed_get():
    """Return the list of dismissed beatmapset IDs."""
    return jsonify({"dismissed": sorted(load_dismissed())})


@app.route("/api/dismissed", methods=["POST"])
def api_dismissed_post():
    """
    Add a beatmapset to the dismissed list.
    Body: {beatmapset_id: N, bm: {...}, bms: {...}}
    bm/bms are optional but enable the disliked-map penalty.
    """
    body = request.get_json(force=True)
    bms_id = body.get("beatmapset_id")
    if bms_id is None:
        return jsonify({"error": "beatmapset_id required"}), 400
    try:
        bms_id = int(bms_id)
    except (TypeError, ValueError):
        return jsonify({"error": "beatmapset_id must be integer"}), 400
    ids = load_dismissed()
    ids.add(bms_id)

    # Optionally store feature vector for negative-feedback scoring
    bm_obj  = body.get("bm") or {}
    bms_obj = body.get("bms") or {}
    if bm_obj:
        try:
            raw_vec = _bm_to_vec(bm_obj, bms_obj).tolist()
            data = _load_dismissed_raw()
            data["ids"] = sorted(ids)
            data.setdefault("entries", [])
            data["entries"] = [e for e in data["entries"] if e.get("bms_id") != bms_id]
            data["entries"].append({
                "bms_id":    bms_id,
                "vec":       raw_vec,
                "creator":   (bms_obj.get("creator") or "").lower().strip(),
                "map_types": classify_map_type(bm_obj, bms_obj),
            })
            with open(DISMISSED_FILE, "w") as f:
                json.dump(data, f, indent=2)
            return jsonify({"ok": True, "dismissed_count": len(ids)})
        except Exception:
            pass  # fall through to simple save

    save_dismissed(ids)
    return jsonify({"ok": True, "dismissed_count": len(ids)})


@app.route("/api/dismissed/<int:bms_id>", methods=["DELETE"])
def api_dismissed_delete(bms_id):
    """Remove a beatmapset from the dismissed list (un-dismiss)."""
    ids = load_dismissed()
    ids.discard(bms_id)
    save_dismissed(ids)
    return jsonify({"ok": True})


# ─────────────────────────────────────────────
# Feedback (liked maps) API routes
# ─────────────────────────────────────────────

@app.route("/api/feedback", methods=["GET"])
def api_feedback_get():
    """Return full liked map entries plus a flat list of IDs."""
    data = load_feedback()
    liked = data.get("liked", [])
    liked_ids = [e["bms_id"] for e in liked if "bms_id" in e]
    return jsonify({"liked": liked_ids, "entries": liked, "count": len(liked)})


@app.route("/api/feedback/like", methods=["POST"])
def api_feedback_like():
    """
    Mark a beatmapset as 'interested / liked'.
    Body: {
      beatmapset_id: N,
      beatmap_id:    N,          # optional — the specific diff the player liked
      bm:            {...},      # beatmap object (for feature vector)
      bms:           {...}       # beatmapset object (for mapper/tags)
    }
    """
    body   = request.get_json(force=True)
    bms_id = body.get("beatmapset_id")
    if bms_id is None:
        return jsonify({"error": "beatmapset_id required"}), 400
    try:
        bms_id = int(bms_id)
    except (TypeError, ValueError):
        return jsonify({"error": "beatmapset_id must be integer"}), 400

    bm_obj  = body.get("bm") or {}
    bms_obj = body.get("bms") or {}

    # Build the feature vector from the supplied beatmap data so future
    # recommendations can compare against it without a round-trip to the API.
    try:
        raw_vec = _bm_to_vec(bm_obj, bms_obj).tolist()
    except Exception:
        raw_vec = None

    entry = {
        "bms_id":   bms_id,
        "bm_id":    body.get("beatmap_id"),
        "liked_at": datetime.now(timezone.utc).isoformat(),
        "vec":      raw_vec,
        "sr":       bm_obj.get("difficulty_rating"),
        "ar":       bm_obj.get("ar"),
        "bpm":      bm_obj.get("bpm") or bms_obj.get("bpm"),
        "creator":  (bms_obj.get("creator") or "").lower().strip(),
        "map_types": classify_map_type(bm_obj, bms_obj) if bm_obj else [],
        "title":    bms_obj.get("title", ""),
        "artist":   bms_obj.get("artist", ""),
        "version":  bm_obj.get("version", ""),
        "covers":   bms_obj.get("covers", {}),
    }

    data = load_feedback()
    # Remove any existing entry for this beatmapset before re-adding
    data["liked"] = [e for e in data.get("liked", []) if e.get("bms_id") != bms_id]
    data["liked"].append(entry)
    save_feedback(data)
    return jsonify({"ok": True, "liked_count": len(data["liked"])})


@app.route("/api/feedback/like/<int:bms_id>", methods=["DELETE"])
def api_feedback_unlike(bms_id):
    """Remove a beatmapset from the liked list (un-like)."""
    data = load_feedback()
    before = len(data.get("liked", []))
    data["liked"] = [e for e in data.get("liked", []) if e.get("bms_id") != bms_id]
    if len(data["liked"]) != before:
        save_feedback(data)
    return jsonify({"ok": True, "liked_count": len(data["liked"])})


# ─────────────────────────────────────────────
# Blocked mappers API
# ─────────────────────────────────────────────

@app.route("/api/blocked-mappers", methods=["GET"])
def api_blocked_mappers_get():
    return jsonify({"blocked": sorted(load_blocked_mappers())})


@app.route("/api/blocked-mappers", methods=["POST"])
def api_blocked_mappers_post():
    body = request.get_json(force=True)
    creator = (body.get("creator") or "").lower().strip()
    if not creator:
        return jsonify({"error": "creator required"}), 400
    names = load_blocked_mappers()
    names.add(creator)
    save_blocked_mappers(names)
    return jsonify({"ok": True, "blocked_count": len(names)})


@app.route("/api/blocked-mappers/<path:creator>", methods=["DELETE"])
def api_blocked_mappers_delete(creator):
    creator = creator.lower().strip()
    names = load_blocked_mappers()
    names.discard(creator)
    save_blocked_mappers(names)
    return jsonify({"ok": True})


@app.route("/api/recommendations/for-play/<int:play_index>")
def api_recommendations_for_play(play_index):
    username = current_username()
    if not username:
        return jsonify({"error": "Not logged in"}), 401
    cfg = load_config()
    try:
        plays = _get_user_plays(username)
        if not plays:
            plays = fetch_top_plays(username, 100)
            _set_user_plays(username, plays)
        if play_index >= len(plays):
            return jsonify({"error": "play index out of range"}), 400
        play = plays[play_index]
        recs = get_recommendations_for_play(play, plays, cfg)
        return jsonify({"recommendations": recs, "play": _serialize_play(play)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/profile-stats")
def api_profile_stats():
    """
    Return the player's taste profile for radar chart display.
    Includes the 8-dim taste vector (denormalised to human ranges),
    map-type weights, dominant mod combo, and skill-gap type.
    """
    username = current_username()
    if not username:
        return jsonify({"error": "Not logged in"}), 401
    cfg = load_config()
    try:
        plays = _get_user_plays(username)
        if not plays:
            plays = fetch_top_plays(username, 100)
            _set_user_plays(username, plays)

        top_n = cfg.get("top_n", 20)
        taste_vec, mapper_w, _, type_w = _build_user_context(plays, top_n)
        if taste_vec is None:
            return jsonify({"error": "Not enough plays"}), 400

        _, dominant_combo = _detect_preferred_mods(plays, top_n)

        # Denormalise taste vector back to human-readable ranges
        axes = [
            {"key": "sr",           "label": "Star Rating",    "value": round(float(taste_vec[0] * 10),    2), "max": 10},
            {"key": "ar",           "label": "Approach Rate",  "value": round(float(taste_vec[1] * 11),    2), "max": 11},
            {"key": "od",           "label": "Overall Diff",   "value": round(float(taste_vec[2] * 10),    2), "max": 10},
            {"key": "cs",           "label": "Circle Size",    "value": round(float(taste_vec[3] * 10),    2), "max": 10},
            {"key": "bpm",          "label": "BPM",            "value": round(float(taste_vec[4] * 400),   1), "max": 400},
            {"key": "density",      "label": "Note Density",   "value": round(float(taste_vec[6] * 15),    2), "max": 15},
        ]

        # Skill gap: least-represented learnable type
        _LEARNABLE = ["streams", "aim", "tech", "reading", "finger control", "speed"]
        gap_type = min(_LEARNABLE, key=lambda t: type_w.get(t, 0.0))
        gap_weight = type_w.get(gap_type, 0.0)

        # Save a daily snapshot for the drift chart
        try:
            snap_sr  = round(float(taste_vec[0] * 10), 2)
            snap_ar  = round(float(taste_vec[1] * 11), 2)
            snap_bpm = round(float(taste_vec[4] * 400), 1)
            save_snapshot(snap_sr, snap_ar, snap_bpm, dominant_combo)
        except Exception:
            pass

        return jsonify({
            "axes":          axes,
            "type_weights":  type_w,
            "dominant_mods": dominant_combo,
            "skill_gap":     gap_type if gap_weight < 0.25 else None,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/taste-snapshots")
def api_taste_snapshots():
    snaps = load_snapshots()
    # Return oldest-first for chart rendering
    return jsonify({"snapshots": list(reversed(snaps))})


@app.route("/api/history")
def api_history():
    return jsonify({"history": load_history()})


@app.route("/api/recommendations/explore")
def api_recommendations_explore():
    """
    Return recommendations for a manually-specified target (SR / AR / BPM).
    Query params: sr, ar, bpm, status ('all'|'ranked'|'loved')
    """
    username = current_username()
    if not username:
        return jsonify({"error": "Not logged in"}), 401
    cfg = load_config()
    try:
        sr  = float(request.args.get("sr",  5.0))
        ar  = float(request.args.get("ar",  9.0))
        bpm = float(request.args.get("bpm", 180.0))
        sr  = max(1.0, min(sr, 15.0))
        ar  = max(0.0, min(ar, 11.0))
        bpm = max(60.0, min(bpm, 400.0))

        plays = _get_user_plays(username)
        if not plays:
            plays = fetch_top_plays(username, 100)
            _set_user_plays(username, plays)

        played_bm_ids  = {p["beatmap"]["id"] for p in plays if p.get("beatmap")}
        played_bms_ids = {p["beatmap"]["beatmapset_id"] for p in plays if p.get("beatmap")}

        # Build a neutral taste vector from the given stats
        dummy_bm = {
            "difficulty_rating": sr, "ar": ar, "accuracy": 8.0, "cs": 4.0,
            "bpm": bpm, "total_length": 120, "count_circles": 500,
            "count_sliders": 200, "max_combo": 700,
        }
        taste_vec = _bm_to_vec(dummy_bm)

        blocked_mappers = load_blocked_mappers()
        disliked_vecs   = _build_disliked_context(load_dismissed_vecs())
        liked_vecs      = _build_liked_context(load_feedback().get("liked", []))
        dismissed_ids   = load_dismissed()

        rec_count = cfg.get("rec_count", 12)
        recs = _query_nerinyan(
            taste_vec, {}, {}, {}, played_bm_ids, played_bms_ids, rec_count,
            sr, ar, bpm,
            pp_target=None, preferred_mods=[],
            liked_vecs=liked_vecs, disliked_vecs=disliked_vecs,
            blocked_mappers=blocked_mappers,
        )
        recs = [r for r in recs if r["beatmapset"]["id"] not in dismissed_ids]
        for r in recs:
            r.setdefault("category", "best_match")
        return jsonify({"recommendations": recs})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/events")
def events():
    """SSE — new top play notifications (local mode only)."""
    def generate():
        last_ka = 0
        while True:
            time.sleep(2)
            with _poll_state["lock"]:
                queue = list(_poll_state["new_play_queue"])
                _poll_state["new_play_queue"].clear()
            for item in queue:
                yield f"event: new_top_play\ndata: {json.dumps(item)}\n\n"
            now = time.time()
            if now - last_ka > 20:
                yield ": keepalive\n\n"
                last_ka = now

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no","Connection":"keep-alive"})


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────

if __name__ == "__main__":
    if not OAUTH_MODE:
        _start_polling()
    port = int(os.environ.get("PORT", 5000))
    print(f"\n  🎯 osu!helper → http://localhost:{port}  (oauth_mode={OAUTH_MODE})\n")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
