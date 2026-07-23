#!/usr/bin/env python3
"""lantern dev server: COOP/COEP isolation headers + ETag revalidation so the
34MB wasm is a 304 on reload unless rebuilt."""
import http.server, os, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        self._etag = None
        path = self.translate_path(self.path)
        if os.path.isfile(path):
            st = os.stat(path)
            etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
                return None
            self._etag = etag
        return super().send_head()

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        if getattr(self, "_etag", None):
            self.send_header("ETag", self._etag)
            self.send_header("Cache-Control", "no-cache")  # revalidate → 304
            self._etag = None
        else:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

Handler.extensions_map[".wasm"] = "application/wasm"
Handler.extensions_map[".js"] = "text/javascript"

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8932
http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
