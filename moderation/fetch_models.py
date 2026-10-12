"""Install the commercial-friendly moderation models into moderation_models/, verifying every checksum.

  python moderation/fetch_models.py                 # download all from the official sources
  python moderation/fetch_models.py --only par      # one model (person | face | gender | par)
  python moderation/fetch_models.py --local par model.xml model.bin   # files you downloaded yourself

Models (all allow commercial use):
  person_yolox.onnx      YOLOX-s, Megvii                       Apache-2.0  person detection
  face_yunet.onnx        YuNet 2023mar, OpenCV Zoo             MIT         face detection
  gender_omz.xml/.bin    OMZ age-gender-recognition-retail-0013 Apache-2.0 gender from the face (faces >= 62px)
  par.xml/.bin           OMZ person-attributes-recognition-crossroad-0230 Apache-2.0 gender from the body
The moderation service uses each one as soon as it is present (restart: docker compose restart moderation).
Checksums: YuNet from its Git LFS object id, OMZ from model.yml in open_model_zoo, YOLOX pinned on first download
of the official 0.1.1rc0 release asset.
"""
import hashlib
import os
import shutil
import sys
import urllib.request

OMZ = "https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1"
MODELS = {
    "person": [("person_yolox.onnx", "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx",
                35858002, "sha256", "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063")],
    "face": [("face_yunet.onnx", "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
              232589, "sha256", "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4")],
    "gender": [
        ("gender_omz.xml", f"{OMZ}/age-gender-recognition-retail-0013/FP32/age-gender-recognition-retail-0013.xml", 30902, "sha384",
         "ab3efa2de0566ceba6e1b3c55774ad9e93e71f9be81506df90d4e7a8055aa98673211af6ef91d848d78849c0cdcb72bc"),
        ("gender_omz.bin", f"{OMZ}/age-gender-recognition-retail-0013/FP32/age-gender-recognition-retail-0013.bin", 8552076, "sha384",
         "a84d760d1d287b7105879c5e93cf5ebd6cbbd34fa809068b118c6adefc62448fefd8d06322dd2266f5ed98b8dd3901fc")],
    "par": [
        ("par.xml", f"{OMZ}/person-attributes-recognition-crossroad-0230/FP32/person-attributes-recognition-crossroad-0230.xml", 183946, "sha384",
         "d16a415f184cdf11e8f78dfc964e337464aba5df325bf378c49d28b4d26d1eff42919963c6a279794ee6e803a78d6fd0"),
        ("par.bin", f"{OMZ}/person-attributes-recognition-crossroad-0230/FP32/person-attributes-recognition-crossroad-0230.bin", 2939232, "sha384",
         "a78e7374128c8f6d7b1ff1b73859d418fae01a4c23284c60acf86d99750a1706985d2e7124a6e2f93e8e0d650f1b9ceb")],
}
DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "moderation_models")


def verify(path, size, algo, digest):
    data = open(path, "rb").read()
    return len(data) == size and hashlib.new(algo, data).hexdigest() == digest


def install(group, local_files=None):
    for i, (name, url, size, algo, digest) in enumerate(MODELS[group]):
        target = os.path.join(DEST, name)
        if os.path.exists(target) and verify(target, size, algo, digest):
            print(f"  {name}: already installed")
            continue
        tmp = target + ".tmp"
        if local_files:
            shutil.copyfile(local_files[i], tmp)
        else:
            urllib.request.urlretrieve(url, tmp)
        if not verify(tmp, size, algo, digest):
            os.remove(tmp)
            raise RuntimeError(f"{name}: size/checksum mismatch - not the official file (blocked or altered download?)")
        os.replace(tmp, target)
        print(f"  {name}: installed (verified)")


def main(argv):
    os.makedirs(DEST, exist_ok=True)
    if argv[:1] == ["--local"] and len(argv) >= 3:
        install(argv[1], argv[2:])
        return 0
    groups = [argv[1]] if argv[:1] == ["--only"] and len(argv) == 2 else list(MODELS)
    failed = []
    for g in groups:
        print(f"{g}:")
        try:
            install(g)
        except Exception as e:  # keep going: each model is optional, the service falls back safely
            print(f"  FAILED: {e}")
            failed.append(g)
    if failed:
        print(f"not installed: {', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
