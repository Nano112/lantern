#!/usr/bin/env python3
"""lantern dev server: static files + the COOP/COEP headers SharedArrayBuffer needs."""
import http.server, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

Handler.extensions_map[".wasm"] = "application/wasm"
Handler.extensions_map[".js"] = "text/javascript"

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8932
http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
