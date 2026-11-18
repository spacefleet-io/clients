# -*- coding: utf-8 -*-
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "resources", "lib"))

import router  # noqa: E402
from compat import log  # noqa: E402

try:
    router.dispatch(sys.argv)
except Exception as exc:  # noqa: BLE001 - never leave Kodi with a silent plugin failure
    import traceback

    log("plugin error: %s\n%s" % (exc, traceback.format_exc()), "error")
    raise
