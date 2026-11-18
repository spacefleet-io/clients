import os
import sys

# The tests sign tickets with the committed dev key (tests/_dev_signer.py), so they take the add-on's explicit dev
# opt-in, like a dev run against a dev stack (privacypass.keys_for_run). Set before any add-on module is imported;
# tests/test_ticket_pin.py proves a run without it pins the production key.
os.environ["SB_DEV_TICKET_KEY"] = "1"

LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin.video.spacebadger", "resources", "lib")
if LIB not in sys.path:
    sys.path.insert(0, os.path.normpath(LIB))
