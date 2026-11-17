#!/usr/bin/env python3
"""Fabrique models/gliner_multi_pii-v1.zip, la zip du modèle lue par le plugin (panneau « modèle manquant »,
scripts/install-model.ps1).

Le modèle est gliner_multi_pii-v1 d'Urchade (Apache 2.0). Urchade ne publie que les poids PyTorch ; le plugin lit de l'ONNX.
On prend la conversion ONNX d'onnx-community (https://huggingface.co/onnx-community/gliner_multi_pii-v1), on vérifie les
empreintes SHA-256 auprès de Hugging Face, puis on met les fichiers à plat dans une zip avec une note d'attribution.

Usage, depuis nodejs-v2 :
    python scripts/build-model-zip.py                       # télécharge (environ 1,2 Go)
    python scripts/build-model-zip.py --source <dossier>    # utilise des fichiers déjà téléchargés (model.onnx à plat ou onnx/model.onnx)

Alternative si ce dépôt disparaît : scripts/export-gliner-colab.py (conversion soi-même, dans Google Colab).
"""
import argparse, hashlib, json, os, shutil, sys, tempfile, urllib.request, zipfile

REPO = "onnx-community/gliner_multi_pii-v1"
API = f"https://huggingface.co/api/models/{REPO}?blobs=true"
BASE = f"https://huggingface.co/{REPO}/resolve/main/"
# nom dans le dépôt -> nom dans la zip (à plat : le plugin ignore les sous-dossiers)
FICHIERS = {
    "onnx/model.onnx": "model.onnx",
    "tokenizer.json": "tokenizer.json",
    "tokenizer_config.json": "tokenizer_config.json",
    "gliner_config.json": "gliner_config.json",
    "special_tokens_map.json": "special_tokens_map.json",
    "added_tokens.json": "added_tokens.json",
}
NOTICE = f"""gliner_multi_pii-v1
===================
Modèle : gliner_multi_pii-v1, auteur Urchade (https://huggingface.co/urchade/gliner_multi_pii-v1), licence Apache 2.0
(https://www.apache.org/licenses/LICENSE-2.0).
Conversion ONNX : {REPO} (https://huggingface.co/{REPO}), fichiers repris tels quels, sans modification des poids.
Ce lot est une simple mise en zip à plat de ces fichiers, faite par scripts/build-model-zip.py.
"""


def sha256(chemin):
    h = hashlib.sha256()
    with open(chemin, "rb") as f:
        for bloc in iter(lambda: f.read(1 << 24), b""):
            h.update(bloc)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", help="dossier déjà téléchargé (au lieu de télécharger)")
    ap.add_argument("--sortie", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "gliner_multi_pii-v1.zip"))
    a = ap.parse_args()
    sortie = os.path.abspath(a.sortie)
    if os.path.exists(sortie):
        sys.exit(f"{sortie} existe déjà : le déplacer ou le renommer avant de relancer.")

    meta = json.load(urllib.request.urlopen(API, timeout=60))
    attendu = {s["rfilename"]: (s.get("lfs") or {}).get("sha256") for s in meta["siblings"]}
    for nom in FICHIERS:
        if nom not in attendu:
            sys.exit(f"Fichier absent du dépôt : {nom}")

    tmp = None
    if a.source:
        dossier = a.source
    else:
        tmp = tempfile.mkdtemp(prefix="gliner-onnx-")
        dossier = tmp
        for nom in FICHIERS:
            dest = os.path.join(dossier, nom)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            print("téléchargement", nom, flush=True)
            urllib.request.urlretrieve(BASE + nom, dest)

    def chemin(nom):
        for c in (os.path.join(dossier, nom), os.path.join(dossier, os.path.basename(nom))):
            if os.path.exists(c):
                return c
        sys.exit(f"Fichier introuvable dans {dossier} : {nom}")

    for nom in FICHIERS:
        c = chemin(nom)
        if attendu[nom]:  # les petits fichiers ne sont pas en LFS : pas d'empreinte à comparer
            if sha256(c) != attendu[nom]:
                sys.exit(f"Empreinte différente de celle de Hugging Face : {nom}")
            print("empreinte conforme :", nom)

    os.makedirs(os.path.dirname(sortie), exist_ok=True)
    with zipfile.ZipFile(sortie, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for nom, dans_zip in FICHIERS.items():
            z.write(chemin(nom), dans_zip)
        z.writestr("NOTICE.txt", NOTICE)
    if tmp:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{sortie} : {os.path.getsize(sortie) / 1024 / 1024:.0f} Mo, sha256 {sha256(sortie)}")


if __name__ == "__main__":
    main()
