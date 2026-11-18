#!/usr/bin/env python3
"""Dev CLI that runs addon logic outside Kodi (no xbmc modules).

  SB_DATA_DIR=/tmp/sbdev python3 tools/sbdev.py login <apiUrl> <email> <password> <keyfile>
  SB_DATA_DIR=/tmp/sbdev python3 tools/sbdev.py sync
  SB_DATA_DIR=/tmp/sbdev python3 tools/sbdev.py serve        # prints master URLs, serves until Ctrl-C

Against a dev stack (its API signs tickets with the committed dev key) add SB_DEV_TICKET_KEY=1: without it the add-on
pins the production ticket key and drops the dev stack's tickets (META-ANON-06).
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin.video.spacebadger", "resources", "lib"))

import core  # noqa: E402
from api import ApiClient  # noqa: E402
from hls import PlaybackServer  # noqa: E402


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "sync"
    if cmd == "login":
        url, email, password, keyfile = argv[2:6]
        api = ApiClient(url)
        api.login(email, password)
        core.save_state(token=api.token, email=email, apiUrl=url.rstrip("/"))
        with open(keyfile) as fh:
            core.save_key(fh.read())
        print("logged in")
    elif cmd == "sync":
        ctx = core.Context()
        print(ctx.lib.sync(ctx.api, ctx.key))
    elif cmd == "serve":
        srv = PlaybackServer(core.Context, "devsecret")
        srv.start()
        ctx = core.Context()
        for m in ctx.lib.list_media("movie"):
            print("movie", m["title"], "%s/m/%s/_/master.m3u8" % (srv.base, m["id"]))
        for m in ctx.lib.list_media("tv"):
            for ep in ctx.lib.episodes(m["id"]):
                if (ep["season_number"], ep["episode_number"]) in ctx.lib.episode_has_files(m["id"]):
                    print("episode", m["title"], ep["season_number"], ep["episode_number"], "%s/m/%s/%s/master.m3u8" % (srv.base, m["id"], ep["id"]))
        sys.stdout.flush()
        while True:
            time.sleep(1)


if __name__ == "__main__":
    main(sys.argv)
