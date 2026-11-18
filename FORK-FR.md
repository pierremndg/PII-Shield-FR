# PII Shield, version française

Ce document décrit ce que cette version change par rapport à PII Shield v2.2.0 (dépôt d'origine, licence MIT). Le code est dans `nodejs-v2/`. Ce document est technique : pour installer et utiliser, voir [README.md](README.md).

## Ce qui change

1. **Modèle** : `gliner_multi_pii-v1` (Urchade) remplace le modèle d'origine. Dossier lu : `~/.pii_shield/models/gliner_multi_pii-v1/`. Le nom est défini une seule fois (`MODEL_SLUG`, `src/engine/ner-backend.ts`). Deux corrections propres à ce modèle : `src/engine/fr-ner-corrections.ts`.
2. **Règles françaises** : identifiants (SIRET, SIREN, FINESS, RPPS, téléphone, IBAN, plaque, RIB), noms avec civilité, organisations et leurs sous-types, adresses, naissance, villes, régions, départements.
   - Identifiants : `src/engine/fr-recognizers.ts`. Une clé de contrôle fausse (NIR, IBAN, RIB, Luhn, TVA, SIRET) donne un type `*_A_VERIFIER` : la valeur est gardée et masquée, jamais supprimée.
   - Règles de texte : `fr-rules.ts` (écrites à la main), `fr-rules-data.ts` (villes, territoires, sous-types), `fr-subtypes.ts`, données `fr-villes.json` et `fr-territoires.json`.
   - Filtres et regroupements : `src/engine/fr-filters.ts`, appelés dans `pii-engine.ts` (`detect()`) dans l'ordre du patch.
   - Types, noms courts, libellés, catégories : une seule liste, `src/engine/fr-referentiel.ts`.
3. **Marqueurs français** : `<PERSONNE_1>`, `<ORGANISATION_1>`, etc.
4. **Juridictions** : non masquées par défaut, la ville qui suit est toujours masquée. Réglage `PII_MASK_COURTS=true` (ou `mask_courts` dans le manifest) pour les masquer.
5. **Panneau de relecture** (`ui/src/review-app.ts`) : textes français, une ligne par étiquette, fusion de marqueurs, changement de catégorie, ajout d'un texte, clic droit, vues Original / Pseudonymisé.
6. **Serveur** : fusion de marqueurs (`overrides.merge`), personnes déjà connues de la session retrouvées dans les documents suivants, profil du moteur dans `list_entities` (`pii_profil`).

## Réglages

| Réglage | Effet |
|---|---|
| variable `PII_MASK_COURTS=true` | Masque aussi les juridictions (défaut : non masquées) |
| variable `PII_FR_PRIORITE=0` | Les règles françaises ne passent plus avant le modèle (comportement d'origine) |
| fichier `~/.pii_shield/fr-debug.on` | Active le journal `~/.pii_shield/fr-debug.jsonl` (une ligne par décision des filtres français) |

## Construire et tester

Depuis `nodejs-v2/` :

```bash
npm run tsc:check:all
npm run build:plugin
npm run smoke
```

Tests (chacun : `npx tsx tests/<fichier>.ts`) : `fr-recognizers-test` (37), `fr-rules-test` (327), `fr-filters-test` (38), `french-courts-test` (27), `fr-ner-corrections-test` (10), plus les tests d'origine mis à jour avec les marqueurs français. `npm run smoke` charge le vrai modèle.

Cette version ne livre pas le skill `pii-contract-analyze` de l'original : il a été retiré (le plugin ne fournit que les outils).

## Limites connues

- **Modèle** : `gliner_multi_pii-v1` d'Urchade (https://huggingface.co/urchade/gliner_multi_pii-v1, licence Apache 2.0), publié seulement en PyTorch ; le plugin lit de l'ONNX. Nous utilisons la conversion ONNX d'`onnx-community` (https://huggingface.co/onnx-community/gliner_multi_pii-v1), sans modifier les poids. Voie principale : la zip `gliner_multi_pii-v1.zip` (environ 935 Mo (892 Mio)), fabriquée par `nodejs-v2/scripts/build-model-zip.py` (télécharge les fichiers, vérifie leurs SHA-256 auprès de Hugging Face, les met à plat avec une note d'attribution) et publiée dans la release ; le panneau « modèle manquant » l'installe depuis Téléchargements. Solutions de repli : `scripts/install-model.ps1` télécharge directement les six fichiers depuis Hugging Face (révision fixe, SHA-256 en dur) sans zip ; `scripts/export-gliner-colab.py` convertit soi-même les poids d'Urchade. Comparée à la conversion Colab : 17 documents identiques sur 18 avec le même plugin (« la CGT » : `<UNION_SYNDICALE_1>` au lieu de `<ORGANISATION_1>`).
- **Panneau « modèle manquant »** : ses boutons (« Télécharger », « Installer la zip téléchargée ») sont ceux d'origine. « Télécharger » récupère `gliner_multi_pii-v1.zip` dans la release `v2.2.0-fr.1` de ce dépôt ; les commandes de repli du panneau (`src/index.ts`) et `install-model.sh` pointent aussi vers ce dépôt.
- **Installation** : essayée dans Claude Desktop sur Windows, modèle déjà en place. Non essayée : installation sur une machine neuve, mode CLI du panneau (`review-cli.html`), macOS et Linux (`install-model.sh`).
- **Juridictions** : leur nom reste visible par défaut, seule la ville qui suit est masquée (voir Réglages). Les sorties diffèrent donc de celles d'un moteur qui masque tout.
