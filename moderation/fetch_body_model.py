"""Install the body-based gender model (OpenVINO Open Model Zoo person-attributes-recognition-crossroad-0230,
Apache-2.0) into moderation_models/par.xml + par.bin, verifying the official SHA-384 checksums.

  python moderation/fetch_body_model.py                       # download from the official storage
  python moderation/fetch_body_model.py model.xml model.bin   # install files you already downloaded

The moderation service picks the model up on its next start (docker compose restart moderation).
"""
import hashlib
import os
import shutil
import sys
import urllib.request

BASE = ("https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/"
        "person-attributes-recognition-crossroad-0230/FP32/person-attributes-recognition-crossroad-0230")
FILES = {  # target name: (official url, size, sha384) - from the model's model.yml in open_model_zoo
    "par.xml": (BASE + ".xml", 183946,
                "d16a415f184cdf11e8f78dfc964e337464aba5df325bf378c49d28b4d26d1eff42919963c6a279794ee6e803a78d6fd0"),
    "par.bin": (BASE + ".bin", 2939232,
                "a78e7374128c8f6d7b1ff1b73859d418fae01a4c23284c60acf86d99750a1706985d2e7124a6e2f93e8e0d650f1b9ceb"),
}
DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "moderation_models")


def verify(path, size, sha):
    data = open(path, "rb").read()
    if len(data) != size or hashlib.sha384(data).hexdigest() != sha:
        raise SystemExit(f"{path}: size/checksum mismatch - not the official file (blocked or altered download?)")


def main():
    os.makedirs(DEST, exist_ok=True)
    local = sys.argv[1:]
    if local and len(local) != 2:
        raise SystemExit(__doc__)
    for i, (name, (url, size, sha)) in enumerate(FILES.items()):
        target = os.path.join(DEST, name)
        tmp = target + ".tmp"
        if local:
            shutil.copyfile(local[i], tmp)
        else:
            urllib.request.urlretrieve(url, tmp)
        try:
            verify(tmp, size, sha)
        except SystemExit:
            os.remove(tmp)
            raise
        os.replace(tmp, target)
        print(f"installed {name} (verified)")


if __name__ == "__main__":
    main()
