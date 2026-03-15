===============================================
  osu!helper — Beatmap Recommendation Engine
===============================================

QUICK START
-----------
Windows: Double-click run.bat
Mac/Linux: bash run.sh

Then open http://localhost:5000 in your browser.


FIRST-TIME SETUP
----------------
You need an osu! OAuth application (free, takes 1 minute):

1. Go to: https://osu.ppy.sh/home/account/edit
2. Scroll to "OAuth" and click "New OAuth Application"
3. Name it anything (e.g. "osu!helper")
4. Leave Callback URL blank
5. Copy your Client ID and Client Secret
6. Paste them into osu!helper when prompted


HOW IT WORKS
------------
• Top Plays tab  — shows your top 100 scores with stats
• Recommendations tab — maps similar to your overall taste profile
• Click "🎯 Similar" on any play to get recs just for that map
• Live polling checks every 30s for new top plays
  → When you set a new score in your top 20, you get
    a new set of fresh recommendations instantly!


SETTINGS (gear icon → Settings tab)
-------------------------------------
  top_n         — how deep in your top plays triggers a new rec set (default: 20)
  poll_interval — how often to check for new scores in seconds (default: 30)
  rec_count     — how many recommendations to show (default: 12)


REQUIREMENTS
------------
Python 3.8+ with pip


DATA SOURCES
------------
• osu! API v2  — your scores, beatmap metadata
• nerinyan.moe — beatmap search with attribute filtering
