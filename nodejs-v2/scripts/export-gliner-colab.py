# Export de urchade/gliner_multi_pii-v1 en ONNX, à lancer dans Google Colab (une seule cellule).
# Produit gliner_multi_pii_onnx.zip : model.onnx, gliner_config.json, fichiers du tokenizer.
# Affiche aussi les scores du modèle sur le texte d'essai du projet (seuil 0,02), pour comparer avec le modèle actuel.
# Aucun document personnel n'est utilisé : le texte d'essai est fictif.
import subprocess, sys

subprocess.run([sys.executable, "-m", "pip", "install", "-q", "gliner==0.2.30", "onnx", "onnxruntime", "onnxscript", "sentencepiece", "protobuf", "tiktoken"], check=True)

import os, shutil, zipfile
import onnx
from gliner import GLiNER

NOM = "urchade/gliner_multi_pii-v1"
SORTIE = "export_onnx"
ENTREES_ATTENDUES = ["input_ids", "attention_mask", "words_mask", "text_lengths", "span_idx", "span_mask"]  # celles du modèle actuel du plugin

modele = GLiNER.from_pretrained(NOM)

# 1. Scores bruts sur le texte d'essai (avant export), pour comparer au modèle actuel.
texte = (
    "Maison Exemple Conseil\n8 allée des Tilleuls, 31000 Toulouse\n\n"
    "Cher Monsieur Fabre, la facture doit être notifiée à Maison Exemple Conseil. "
    "SIRET de la société Fournisseur Fictif. Courrier de J. Exemplaire reçu. "
    "Le contrat a été signé. Il a signé le 3 mars 2026. Office Lenoir & Associés. "
    "Monsieur Jean Exemplaire, né le 15/01/1985."
)
etiquettes = ["person", "organization", "address", "date of birth", "phone number", "email", "location"]
print("=== Scores du modèle (avant export) ===")
for e in sorted(modele.predict_entities(texte, etiquettes, threshold=0.02), key=lambda e: e["start"]):
    print(f'{e["score"]:.2f}  {e["label"]:<14} {e["text"]!r}')

# 2. Export ONNX
shutil.rmtree(SORTIE, ignore_errors=True)
modele.export_to_onnx(SORTIE, opset=19)

# 3. Réécriture en un seul fichier, IR 9 (comme le modèle actuel)
chemin = os.path.join(SORTIE, "model.onnx")
m = onnx.load(chemin)  # charge aussi d'éventuelles données externes
m.ir_version = 9
onnx.save_model(m, chemin, save_as_external_data=False)
for f in os.listdir(SORTIE):
    if f.endswith(".data"):
        os.remove(os.path.join(SORTIE, f))

# 4. Contrôles
entrees = [i.name for i in onnx.load(chemin).graph.input]
print("\n=== Contrôles ===")
print("entrées :", entrees)
print("mêmes entrées que le modèle actuel :", entrees == ENTREES_ATTENDUES)
print("taille model.onnx : %.0f Mo" % (os.path.getsize(chemin) / 1e6))
print("tokenizer.json présent :", os.path.exists(os.path.join(SORTIE, "tokenizer.json")))
print("fichiers :", sorted(os.listdir(SORTIE)))

# 5. Archive
with zipfile.ZipFile("gliner_multi_pii_onnx.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for f in os.listdir(SORTIE):
        z.write(os.path.join(SORTIE, f), f)
print("archive : gliner_multi_pii_onnx.zip")
try:
    from google.colab import files
    files.download("gliner_multi_pii_onnx.zip")
except ImportError:
    pass
