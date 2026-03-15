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
import requests
import json
import time
import threading
import os
import statistics
import uuid
import secrets
from datetime import datetime, timezone
from urllib.parse import urlencode

# ─────────────────────────────────────────────
# App setup
# ─────────────────────────────────────────────

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))

BASE_DIR        = os.path.dirname(__file__)
CONFIG_FILE     = os.path.join(BASE_DIR, "config.json")
PROFILES_FILE   = os.path.join(BASE_DIR, "profiles.json")
OSU_API_BASE    = "https://osu.ppy.sh/api/v2"
OSU_TOKEN_URL   = "https://osu.ppy.sh/oauth/token"
OSU_AUTH_URL    = "https://osu.ppy.sh/oauth/authorize"
NERINYAN_API    = "https://api.nerinyan.moe/search"

# Detect mode
OAUTH_MODE = os.environ.get("OAUTH_MODE", "").strip() in ("1", "true", "yes")

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
# Recommendation engine (unchanged)
# ─────────────────────────────────────────────

def _score_similarity(bm, target):
    diff = 0
    diff += abs(bm.get("difficulty_rating", 0) - target["sr"]) * 3.0
    diff += abs(bm.get("ar", 0) - target["ar"]) * 1.0
    diff += abs(bm.get("accuracy", 0) - target["od"]) * 0.5
    diff += abs(bm.get("cs", 0) - target["cs"]) * 0.3
    bpm = bm.get("bpm", target["bpm"])
    diff += abs(bpm - target["bpm"]) / target["bpm"] * 5 if target["bpm"] else 0
    return -diff


def _build_target(play):
    bm  = play.get("beatmap", {})
    bms = play.get("beatmapset", {})
    return {
        "sr":  bm.get("difficulty_rating", 5.0),
        "ar":  bm.get("ar", 9.0),
        "od":  bm.get("accuracy", 8.0),
        "cs":  bm.get("cs", 4.0),
        "hp":  bm.get("drain", 5.0),
        "bpm": bm.get("bpm") or bms.get("bpm", 180),
        "beatmap_id": bm.get("id"),
        "beatmapset_id": bm.get("beatmapset_id"),
        "title": bms.get("title", ""),
        "artist": bms.get("artist", ""),
        "creator": bms.get("creator", ""),
    }


def _profile_from_top_plays(plays, top_n=20):
    slice_ = plays[:top_n]
    srs, ars, ods, css, bpms = [], [], [], [], []
    for p in slice_:
        bm  = p.get("beatmap", {})
        bms = p.get("beatmapset", {})
        srs.append(bm.get("difficulty_rating", 5.0))
        ars.append(bm.get("ar", 9.0))
        ods.append(bm.get("accuracy", 8.0))
        css.append(bm.get("cs", 4.0))
        raw_bpm = bm.get("bpm") or bms.get("bpm")
        if raw_bpm:
            bpms.append(raw_bpm)
    med = statistics.median
    bpm_med = med(bpms) if bpms else 180
    return {
        "sr": med(srs), "ar": med(ars), "od": med(ods), "cs": med(css),
        "hp": 5.0, "bpm": bpm_med,
        "beatmap_id": None, "beatmapset_id": None,
        "title": "", "artist": "", "creator": "",
    }


def _build_reason(bm, target):
    reasons = []
    sr_diff  = abs(bm.get("difficulty_rating", 0) - target["sr"])
    ar_diff  = abs(bm.get("ar", 0) - target["ar"])
    bpm      = bm.get("bpm", target["bpm"])
    bpm_pct  = abs(bpm - target["bpm"]) / max(target["bpm"], 1) * 100 if target["bpm"] else 0
    if sr_diff < 0.3:  reasons.append(f"very similar difficulty ({bm.get('difficulty_rating',0):.1f}★)")
    elif sr_diff < 0.6: reasons.append(f"close difficulty ({bm.get('difficulty_rating',0):.1f}★)")
    if ar_diff < 0.5:  reasons.append(f"same AR ({bm.get('ar',0):.1f})")
    if bpm_pct < 10:   reasons.append(f"similar BPM ({bpm:.0f})")
    if not reasons:    reasons.append(f"{bm.get('difficulty_rating',0):.1f}★, AR{bm.get('ar',0):.1f}")
    return " · ".join(reasons)


def _query_nerinyan(target, played_bm_ids, played_bms_ids, rec_count=12, tolerance=1.0):
    sr, ar, bpm = target["sr"], target["ar"], target["bpm"]
    params = {
        "m": 0, "r": "1,2,4",
        "diff": f"{max(0, sr-tolerance):.1f}-{sr+tolerance:.1f}",
        "ar":   f"{max(0, ar-1.0):.1f}-{min(11, ar+1.0):.1f}",
        "bpm":  f"{bpm*0.80:.0f}-{bpm*1.20:.0f}",
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
        bms_id = bms.get("id")
        if bms_id in played_bms_ids: continue
        for bm in bms.get("beatmaps", []):
            mode_int = bm.get("mode_int", bm.get("mode"))
            if mode_int != 0 and bm.get("mode") not in ("osu", "osu!"): continue
            bm_id = bm.get("id")
            if bm_id in played_bm_ids: continue
            bm["bpm"] = bm.get("bpm") or bms.get("bpm", target["bpm"])
            results.append({
                "beatmapset": {
                    "id": bms.get("id"), "title": bms.get("title",""),
                    "artist": bms.get("artist",""), "creator": bms.get("creator",""),
                    "covers": bms.get("covers",{}), "ranked": bms.get("ranked"),
                    "status": bms.get("status",""), "bpm": bms.get("bpm"),
                },
                "beatmap": {
                    "id": bm.get("id"), "version": bm.get("version",""),
                    "difficulty_rating": bm.get("difficulty_rating",0),
                    "ar": bm.get("ar",0), "accuracy": bm.get("accuracy",0),
                    "cs": bm.get("cs",0), "drain": bm.get("drain",0),
                    "bpm": bm.get("bpm"), "total_length": bm.get("total_length",0),
                    "url": bm.get("url", f"https://osu.ppy.sh/b/{bm.get('id')}"),
                },
                "score": _score_similarity(bm, target),
                "reason": _build_reason(bm, target),
                "source": "nerinyan",
            })

    results.sort(key=lambda x: x["score"], reverse=True)
    seen, out = set(), []
    for r in results:
        bid = r["beatmapset"]["id"]
        if bid not in seen:
            seen.add(bid)
            out.append(r)
    return out[:rec_count]


def _query_osu_search(target, played_bms_ids, rec_count=8):
    sr = target["sr"]
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
            if abs(bm.get("difficulty_rating",0) - sr) > 1.2: continue
            bm["bpm"] = bm.get("bpm") or bms.get("bpm", target["bpm"])
            results.append({
                "beatmapset": {
                    "id": bms.get("id"), "title": bms.get("title",""),
                    "artist": bms.get("artist",""), "creator": bms.get("creator",""),
                    "covers": bms.get("covers",{}), "ranked": bms.get("ranked"),
                    "status": bms.get("status",""), "bpm": bms.get("bpm"),
                },
                "beatmap": {
                    "id": bm.get("id"), "version": bm.get("version",""),
                    "difficulty_rating": bm.get("difficulty_rating",0),
                    "ar": bm.get("ar",0), "accuracy": bm.get("accuracy",0),
                    "cs": bm.get("cs",0), "drain": bm.get("drain",0),
                    "bpm": bm.get("bpm"), "total_length": bm.get("total_length",0),
                    "url": bm.get("url", f"https://osu.ppy.sh/b/{bm.get('id')}"),
                },
                "score": _score_similarity(bm, target),
                "reason": _build_reason(bm, target),
                "source": "osu",
            })
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:rec_count]


def get_recommendations_for_profile(top_plays, cfg):
    top_n     = cfg.get("top_n", 20)
    rec_count = cfg.get("rec_count", 12)
    played_bm_ids  = {p["beatmap"]["id"] for p in top_plays if p.get("beatmap")}
    played_bms_ids = {p["beatmap"]["beatmapset_id"] for p in top_plays if p.get("beatmap")}
    target = _profile_from_top_plays(top_plays, top_n)
    recs = _query_nerinyan(target, played_bm_ids, played_bms_ids, rec_count)
    if len(recs) < rec_count // 2:
        recs += _query_osu_search(target, played_bms_ids, rec_count - len(recs))
    seen, out = set(), []
    for r in recs:
        bid = r["beatmapset"]["id"]
        if bid not in seen:
            seen.add(bid)
            out.append(r)
    return out[:rec_count]


def get_recommendations_for_play(play, top_plays, cfg):
    rec_count      = cfg.get("rec_count", 12)
    played_bm_ids  = {p["beatmap"]["id"] for p in top_plays if p.get("beatmap")}
    played_bms_ids = {p["beatmap"]["beatmapset_id"] for p in top_plays if p.get("beatmap")}
    target = _build_target(play)
    recs = _query_nerinyan(target, played_bm_ids, played_bms_ids, rec_count)
    if len(recs) < rec_count // 2:
        recs += _query_osu_search(target, played_bms_ids, rec_count - len(recs))
    seen, out = set(), []
    for r in recs:
        bid = r["beatmapset"]["id"]
        if bid not in seen:
            seen.add(bid)
            out.append(r)
    return out[:rec_count]


# ─────────────────────────────────────────────
# Live polling (local mode only)
# ─────────────────────────────────────────────

_poll_state = {
    "top_plays": [], "last_top_ids": [],
    "new_play_queue": [], "lock": threading.Lock(), "running": False,
}


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
            "url": bm.get("url"),
        },
        "beatmapset": {
            "id": bms.get("id"), "title": bms.get("title"),
            "artist": bms.get("artist"), "creator": bms.get("creator"),
            "covers": bms.get("covers", {}), "bpm": bms.get("bpm"),
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
        return jsonify({
            "logged_in":    True,
            "oauth_mode":   True,
            "username":     session.get("osu_username"),
            "user_id":      session.get("osu_user_id"),
            "avatar_url":   session.get("osu_avatar"),
            "pp":           session.get("osu_pp"),
            "global_rank":  session.get("osu_rank"),
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
        with _poll_state["lock"]:
            _poll_state["top_plays"] = plays
            if not _poll_state["last_top_ids"]:
                _poll_state["last_top_ids"] = [p["best_id"] for p in plays[:cfg.get("top_n",20)]]
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
        with _poll_state["lock"]:
            plays = _poll_state["top_plays"]
        if not plays:
            plays = fetch_top_plays(username, 100)
            with _poll_state["lock"]:
                _poll_state["top_plays"] = plays
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
        with _poll_state["lock"]:
            plays = _poll_state["top_plays"]
        if not plays:
            plays = fetch_top_plays(username, 100)
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
