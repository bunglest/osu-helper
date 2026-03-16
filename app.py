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

CONFIG_FILE     = os.path.join(DATA_DIR, "config.json")
PROFILES_FILE   = os.path.join(DATA_DIR, "profiles.json")
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
    "top_n": 20,
    "poll_interval": 30,
    "rec_count": 12,
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
    """Classify a beatmap into one or two type labels using attribute heuristics."""
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

    return types[:2] if types else ["misc"]


# ─────────────────────────────────────────────
# AI recommendation engine
# ─────────────────────────────────────────────

# Feature vector layout: [sr, ar, od, cs, bpm, length, note_density]
# note_density = circles/drain_time captures how "streamy" a map is
_FEAT_W = np.array([3.0, 1.8, 0.8, 0.5, 1.2, 0.3, 2.0], dtype=float)


def _note_density(bm):
    """Circles per second — key stream/aim discriminator."""
    circles = int(bm.get("count_circles") or 0)
    drain   = max(float(bm.get("drain") or bm.get("total_length") or 60), 1)
    return circles / drain


def _bm_to_vec(bm, bms=None):
    """Normalise a beatmap's attributes into a 7-dim feature vector."""
    bms = bms or {}
    bpm     = float(bm.get("bpm") or bms.get("bpm") or 180)
    density = min(_note_density(bm), 15) / 15.0   # cap at 15 circles/sec
    return np.array([
        float(bm.get("difficulty_rating", 5)) / 10.0,
        float(bm.get("ar", 9))               / 11.0,
        float(bm.get("accuracy", 8))         / 10.0,
        float(bm.get("cs", 4))               / 10.0,
        min(bpm, 400)                         / 400.0,
        min(float(bm.get("total_length", 120)), 600) / 600.0,
        density,
    ], dtype=float)


def _cosine(a, b):
    n = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b)) / n if n > 0 else 0.0


def _build_user_context(plays, top_n=20):
    """
    Return (taste_vec, mapper_weights, tag_weights, type_weights) from top plays.
    taste_vec    — PP-weighted average feature vector
    mapper_weights — {creator_lower: normalised_score}
    tag_weights  — {tag: normalised_score}  (lightly weighted in scoring)
    type_weights — {type_label: normalised_score}
    """
    slice_ = plays[:top_n]
    if not slice_:
        return None, {}, {}, {}

    vecs, pps = [], []
    mapper_raw, tag_raw, type_raw = {}, {}, {}

    for play in slice_:
        bm  = play.get("beatmap", {})
        bms = play.get("beatmapset", {})
        pp  = float(play.get("pp") or 1)

        vecs.append(_bm_to_vec(bm, bms))
        pps.append(pp)

        creator = (bms.get("creator") or "").lower().strip()
        if creator:
            mapper_raw[creator] = mapper_raw.get(creator, 0) + pp

        for tag in (bms.get("tags") or "").lower().split():
            if len(tag) > 2:
                tag_raw[tag] = tag_raw.get(tag, 0) + pp

        for t in classify_map_type(bm, bms):
            type_raw[t] = type_raw.get(t, 0) + pp

    vecs_np = np.array(vecs)
    pps_np  = np.array(pps)
    pps_np  = pps_np / pps_np.sum()
    taste_vec = np.average(vecs_np, axis=0, weights=pps_np)

    def _normalise(d):
        mx = max(d.values()) if d else 1
        return {k: v / mx for k, v in d.items()}

    return taste_vec, _normalise(mapper_raw), _normalise(tag_raw), _normalise(type_raw)


def _ai_score(bm, bms, taste_vec, mapper_w, tag_w, type_w):
    """Score a candidate map (higher = better match). Returns (score, reason_str)."""
    vec      = _bm_to_vec(bm, bms) * _FEAT_W
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

    # ── Mapper bonus (max +12) ──────────────
    creator = (bms.get("creator") or "").lower().strip()
    if creator and creator in mapper_w:
        bonus = mapper_w[creator] * 12
        score += bonus
        reasons.append(f"by a mapper you like ({bms.get('creator','')})")

    # ── Tag overlap bonus (lightly weighted, max +5) ──
    bm_tags = set((bms.get("tags") or "").lower().split())
    if bm_tags and tag_w:
        top_tags = set(sorted(tag_w, key=tag_w.get, reverse=True)[:30])
        overlap  = len(bm_tags & top_tags)
        if overlap:
            score += min(overlap / max(len(top_tags), 1), 1.0) * 5

    # ── Map-type preference bonus (max +8) ──
    bm_types = classify_map_type(bm, bms)
    for t in bm_types:
        if t in type_w:
            score += type_w[t] * 8
            break  # only count once

    if not reasons:
        reasons.append(f"{sr:.1f}★, AR{ar:.1f}")

    return score, " · ".join(reasons)


def _build_target_context(play):
    """Build a single-play context for 'similar to this map' mode."""
    bm  = play.get("beatmap", {})
    bms = play.get("beatmapset", {})
    vec = _bm_to_vec(bm, bms)
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
        "url": bm.get("url", f"https://osu.ppy.sh/b/{bm.get('id')}"),
        "map_types": classify_map_type(bm, bms),
    }


def _query_nerinyan(taste_vec, mapper_w, tag_w, type_w, played_bm_ids, played_bms_ids,
                    rec_count=12, sr_center=5.0, ar_center=9.0, bpm_center=180):
    params = {
        "m": 0, "r": "1,2,4",
        "diff": f"{max(0, sr_center-1.0):.1f}-{sr_center+1.0:.1f}",
        "ar":   f"{max(0, ar_center-1.2):.1f}-{min(11, ar_center+1.2):.1f}",
        "bpm":  f"{bpm_center*0.78:.0f}-{bpm_center*1.22:.0f}",
        "p": 0, "ps": 50,
    }
    try:
        resp = requests.get(NERINYAN_API, params=params, timeout=10)
        if not resp.ok: return []
        beatmapsets = resp.json()
        if not isinstance(beatmapsets, list): return []
    except Exception:
        return []

    results = []
    for bms in beatmapsets:
        if not isinstance(bms, dict): continue
        if bms.get("id") in played_bms_ids: continue
        for bm in bms.get("beatmaps", []):
            mode_int = bm.get("mode_int", bm.get("mode"))
            if mode_int != 0 and bm.get("mode") not in ("osu", "osu!"): continue
            if bm.get("id") in played_bm_ids: continue
            bm["bpm"] = bm.get("bpm") or bms.get("bpm", bpm_center)
            score, reason = _ai_score(bm, bms, taste_vec, mapper_w, tag_w, type_w)
            results.append({
                "beatmapset": _pack_bms(bms),
                "beatmap":    _pack_bm(bm, bms),
                "score": score, "reason": reason, "source": "nerinyan",
            })

    results.sort(key=lambda x: x["score"], reverse=True)
    seen, out = set(), []
    for r in results:
        bid = r["beatmapset"]["id"]
        if bid not in seen:
            seen.add(bid); out.append(r)
    return out[:rec_count]


def _query_osu_search(taste_vec, mapper_w, tag_w, type_w, played_bms_ids,
                      rec_count=8, sr_center=5.0):
    try:
        data = osu_get("/beatmapsets/search", {"m":0,"s":"ranked","sort":"plays_desc","q":""})
        beatmapsets = data.get("beatmapsets", [])
    except Exception:
        return []
    results = []
    for bms in beatmapsets:
        if bms.get("id") in played_bms_ids: continue
        for bm in bms.get("beatmaps", []):
            if bm.get("mode") != "osu": continue
            if abs(bm.get("difficulty_rating",0) - sr_center) > 1.5: continue
            bm["bpm"] = bm.get("bpm") or bms.get("bpm", 180)
            score, reason = _ai_score(bm, bms, taste_vec, mapper_w, tag_w, type_w)
            results.append({
                "beatmapset": _pack_bms(bms),
                "beatmap":    _pack_bm(bm, bms),
                "score": score, "reason": reason, "source": "osu",
            })
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:rec_count]


def get_recommendations_for_profile(top_plays, cfg):
    top_n     = cfg.get("top_n", 20)
    rec_count = cfg.get("rec_count", 12)
    played_bm_ids  = {p["beatmap"]["id"] for p in top_plays if p.get("beatmap")}
    played_bms_ids = {p["beatmap"]["beatmapset_id"] for p in top_plays if p.get("beatmap")}

    taste_vec, mapper_w, tag_w, type_w = _build_user_context(top_plays, top_n)
    if taste_vec is None:
        return []

    # Pull search center from taste vector
    sr_c  = float(taste_vec[0] * 10)
    ar_c  = float(taste_vec[1] * 11)
    bpm_c = float(taste_vec[4] * 400)

    recs = _query_nerinyan(taste_vec, mapper_w, tag_w, type_w,
                           played_bm_ids, played_bms_ids, rec_count,
                           sr_c, ar_c, bpm_c)
    if len(recs) < rec_count // 2:
        recs += _query_osu_search(taste_vec, mapper_w, tag_w, type_w,
                                  played_bms_ids, rec_count - len(recs), sr_c)
    seen, out = set(), []
    for r in recs:
        bid = r["beatmapset"]["id"]
        if bid not in seen:
            seen.add(bid); out.append(r)
    return out[:rec_count]


def get_recommendations_for_play(play, top_plays, cfg):
    rec_count      = cfg.get("rec_count", 12)
    played_bm_ids  = {p["beatmap"]["id"] for p in top_plays if p.get("beatmap")}
    played_bms_ids = {p["beatmap"]["beatmapset_id"] for p in top_plays if p.get("beatmap")}

    taste_vec, mapper_w, tag_w, type_w = _build_target_context(play)
    bm  = play.get("beatmap", {})
    bms = play.get("beatmapset", {})
    sr_c  = float(bm.get("difficulty_rating", 5))
    ar_c  = float(bm.get("ar", 9))
    bpm_c = float(bm.get("bpm") or bms.get("bpm") or 180)

    recs = _query_nerinyan(taste_vec, mapper_w, tag_w, type_w,
                           played_bm_ids, played_bms_ids, rec_count,
                           sr_c, ar_c, bpm_c)
    if len(recs) < rec_count // 2:
        recs += _query_osu_search(taste_vec, mapper_w, tag_w, type_w,
                                  played_bms_ids, rec_count - len(recs), sr_c)
    seen, out = set(), []
    for r in recs:
        bid = r["beatmapset"]["id"]
        if bid not in seen:
            seen.add(bid); out.append(r)
    return out[:rec_count]


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
    if OAUTH_MODE:
        if "osu_username" not in session:
            return jsonify({"logged_in": False, "oauth_mode": True})
        cfg = load_config()
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
        })
    else:
        p = get_active_profile()
        cfg = load_config()
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
        })


@app.route("/api/config", methods=["POST"])
def api_config_post():
    """Save global settings (top_n, poll_interval, rec_count)."""
    body = request.get_json(force=True)
    cfg  = load_config()
    for key in ("top_n", "poll_interval", "rec_count"):
        if key in body:
            cfg[key] = body[key]
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
    try:
        plays = _get_user_plays(username)
        if not plays:
            plays = fetch_top_plays(username, 100)
            _set_user_plays(username, plays)
        recs = get_recommendations_for_profile(plays, cfg)
        return jsonify({"recommendations": recs})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
