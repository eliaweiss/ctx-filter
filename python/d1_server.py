"""ctx-filter d1 daemon: keeps LiquidAI d1 (MLX) loaded and answers system_one_batch over a unix socket.

Usage: python -I d1_server.py <socket_path> <model_dir> <idle_minutes>

Protocol: one JSON object per line in, one per line out, one request per connection.
  in:  {"requests": [{"state": ..., "questions": {...}}, ...]}
  out: {"results": [<system_one answer dict>, ...]}  or  {"error": "..."}
The server is single-threaded on purpose: MLX runs one batch at a time.
"""
import json
import os
import socket
import socketserver
import sys
import threading
import time

SOCK, MODEL, IDLE_MIN = sys.argv[1], sys.argv[2], float(sys.argv[3])


def alive(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(path)
        return True
    except OSError:
        return False
    finally:
        s.close()


if os.path.exists(SOCK) and alive(SOCK):
    print("another daemon is serving", SOCK, flush=True)
    sys.exit(0)

from mlx_vlm import load  # noqa: E402  (slow import; only after the liveness check)

t0 = time.time()
model, _ = load(MODEL)
model.system_one("warm up", {"w": {"type": "noul", "instructions": "Is this a test?"}})
print(f"loaded {MODEL} in {time.time() - t0:.1f}s", flush=True)

last_used = time.time()


def plain(o):
    try:
        return float(o)
    except Exception:
        return str(o)


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        global last_used
        line = self.rfile.readline()
        if not line:
            return
        try:
            req = json.loads(line)
            pairs = [(r["state"], r["questions"]) for r in req["requests"]]
            t = time.time()
            out = model.system_one_batch(pairs)
            reply = {"results": [o["answers"] for o in out], "ms": round((time.time() - t) * 1000)}
        except Exception as e:  # report to the client, keep serving
            reply = {"error": f"{type(e).__name__}: {e}"}
        last_used = time.time()
        self.wfile.write((json.dumps(reply, default=plain) + "\n").encode())


if os.path.exists(SOCK):
    os.unlink(SOCK)
server = socketserver.UnixStreamServer(SOCK, Handler)
os.chmod(SOCK, 0o600)


def watchdog():
    while True:
        time.sleep(15)
        if time.time() - last_used > IDLE_MIN * 60:
            print("idle, exiting", flush=True)
            server.shutdown()
            return


threading.Thread(target=watchdog, daemon=True).start()
try:
    server.serve_forever()
finally:
    server.server_close()
    try:
        os.unlink(SOCK)
    except OSError:
        pass
