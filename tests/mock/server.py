from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


WORKSPACE = Path(__file__).resolve().parents[2]
MOCK_ROOT = Path(__file__).resolve().parent
MOCK_HTML = MOCK_ROOT / "issue" / "TAB-TEST" / "index.html"
EXTENSION_SCRIPT = WORKSPACE / "extension" / "content.js"
ZIP_BUILDER_SCRIPT = WORKSPACE / "extension" / "zip-builder.js"
MOCK_PORT = int(os.environ.get("TEAL_MOCK_PORT", "8769"))


MOCK_SOURCE_BYTES_BY_FILENAME = {
    "existing-alpha.txt": b"alpha",
    "existing-beta.csv": b"beta",
    "existing-gamma.json": b"gamma",
    "existing-delta.md": b"delta",
}


def make_hash(name):
    if name in MOCK_SOURCE_BYTES_BY_FILENAME:
        return hashlib.sha256(MOCK_SOURCE_BYTES_BY_FILENAME[name]).hexdigest()
    value = 0
    for byte in name.encode("utf-8"):
        value = (value * 31 + byte) & 0xFFFFFFFF
    return f"{value:08x}" * 8


STAGED_FILES = (
    {
        "id": "9ae5cf2d-1d44-4a5a-8e8d-336720fa7f01",
        "filename": "existing-alpha.txt",
        "byte_size": 5,
    },
    {
        "id": "4e975b3a-c65d-482a-bdac-e7d7b0a1a902",
        "filename": "existing-beta.csv",
        "byte_size": 4,
    },
    {
        "id": "ab506a95-8135-46d4-9a98-47be5cd4b203",
        "filename": "existing-gamma.json",
        "byte_size": 5,
    },
    {
        "id": "d2a78246-68f3-49bb-bec4-c195dfebc304",
        "filename": "existing-delta.md",
        "byte_size": 5,
    },
)

MOCK_DOWNLOAD_BYTES = {
    row["id"]: MOCK_SOURCE_BYTES_BY_FILENAME[row["filename"]]
    for row in STAGED_FILES
}

DEMO_ISSUE_IDENTIFIERS = {"TAB-TEST", "DEMO-204"}


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        request = urlsplit(self.path)
        path = request.path
        if path.rstrip("/") in {f"/issue/{identifier}" for identifier in DEMO_ISSUE_IDENTIFIERS}:
            return self.send_file(MOCK_HTML, "text/html; charset=utf-8")
        if path == "/api/staged-files":
            issue_identifier = parse_qs(request.query).get("issue_identifier", [None])[0]
            if issue_identifier not in DEMO_ISSUE_IDENTIFIERS:
                return self.send_json({"error": "Unknown issue identifier."}, status=404)
            rows = [
                {**row, "sha256": make_hash(row["filename"])}
                for row in STAGED_FILES
            ]
            return self.send_json({"rows": rows})
        if path.startswith("/api/staged-files/") and path.endswith("/download-url"):
            staged_id = path.removeprefix("/api/staged-files/").removesuffix("/download-url").strip("/")
            if staged_id not in MOCK_DOWNLOAD_BYTES:
                return self.send_json({"error": "Unknown staged file."}, status=404)
            return self.send_json({
                "download_url": f"http://127.0.0.1:{MOCK_PORT}/mock-downloads/{staged_id}"
            })
        if path.startswith("/mock-downloads/"):
            staged_id = path.removeprefix("/mock-downloads/")
            data = MOCK_DOWNLOAD_BYTES.get(staged_id)
            if data is None:
                return self.send_error(404)
            return self.send_bytes(data, "application/octet-stream")
        if path == "/content.js":
            return self.send_file(EXTENSION_SCRIPT, "text/javascript; charset=utf-8")
        if path == "/zip-builder.js":
            return self.send_file(ZIP_BUILDER_SCRIPT, "text/javascript; charset=utf-8")
        self.send_error(404)

    def send_file(self, path, content_type):
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_bytes(self, data, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload, status=200):
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), Handler).serve_forever()
