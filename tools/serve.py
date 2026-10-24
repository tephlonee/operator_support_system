"""
serve.py
Local web server for the mock-up. It works like "python -m http.server", but also tells the browser
not to keep old copies of the files. Without that, the browser can keep showing an old version
of the app after the code has changed.

Run from the project folder:  python tools/serve.py
Then open http://localhost:8000/  (stop the server with Ctrl+C)
Only the Python standard library is used.
"""
import functools
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    # 127.0.0.1: only this computer can open the app.
    with http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler) as httpd:
        print(f'Serving the mock-up at http://localhost:{PORT}/  (Ctrl+C to stop)', flush=True)
        httpd.serve_forever()
