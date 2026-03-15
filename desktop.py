"""
osu!helper — Desktop launcher (PyWebView)
Starts the Flask server in a background thread, then opens
a native app window — no browser, no terminal visible.
"""

import sys
import os
import threading
import time
import urllib.request

# Ensure we can find app.py
sys.path.insert(0, os.path.dirname(__file__))


def wait_for_server(port, timeout=15):
    """Poll until Flask is accepting connections."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def start_flask(port):
    from app import app, _start_polling, OAUTH_MODE
    if not OAUTH_MODE:
        _start_polling()
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True, use_reloader=False)


if __name__ == "__main__":
    try:
        import webview
    except ImportError:
        print("Installing pywebview…")
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pywebview", "--quiet"])
        import webview

    PORT = 5099  # use a different port to avoid clashing with local dev server

    # Start Flask in background
    flask_thread = threading.Thread(target=start_flask, args=(PORT,), daemon=True)
    flask_thread.start()

    print("  🎯 Starting osu!helper…")
    if not wait_for_server(PORT):
        print("  ERROR: Server failed to start.")
        sys.exit(1)

    # Create native window
    window = webview.create_window(
        title="osu!helper",
        url=f"http://127.0.0.1:{PORT}",
        width=1280,
        height=820,
        min_size=(960, 640),
        resizable=True,
        text_select=True,
    )
    webview.start(debug=False)
