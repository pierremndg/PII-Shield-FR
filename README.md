# PII Shield FR

**Anonymiser les documents avant que Claude les lise, puis restaurer les vraies données après l'analyse.**

PII Shield FR est une version française de [PII Shield](https://github.com/gregmos/PII-Shield) (par gregmos, licence MIT), un plugin pour Claude Desktop. Il détecte les données personnelles d'un document sur votre ordinateur, les remplace par des marqueurs (`<PERSONNE_1>`, `<ORGANISATION_1>`…) et ne donne à Claude que le texte anonymisé. Après l'analyse, il remet les vraies données dans le document final, toujours en local.

```
Document ──> [PII Shield sur votre machine] ──> texte anonymisé ──> [Claude analyse] ──> [PII Shield restaure] ──> Résultat
              Jean Dupont         → <PERSONNE_1>                                         <PERSONNE_1> → Jean Dupont
              Atelier Fictif SARL → <SARL_1>                                             <SARL_1>     → Atelier Fictif SARL
```

> Ce dépôt est un fork. Ce README décrit **la version française**. Le README du projet d'origine (en anglais, non modifié) est conservé dans [README-original.md](README-original.md).

## Ce qui est différent de l'original

- **Règles françaises** : SIRET, SIREN, IBAN, NIR, TVA, plaques, noms avec civilité, organisations, adresses, juridictions.
- **Marqueurs et panneau de relecture en français** (`<PERSONNE_1>` au lieu de `<PERSON_1>`).
- **Autre modèle de détection** : `gliner_multi_pii-v1` d'[Urchade](https://huggingface.co/urchade/gliner_multi_pii-v1) (licence Apache 2.0), à la place de `knowledgator/gliner-pii-base-v1.0`.
- **Retiré ou non repris** : le skill `pii-contract-analyze`, la variante macOS, la publication sur npm.

Le détail technique et les réglages sont dans [FORK-FR.md](FORK-FR.md).

## Installer (Windows)

Prérequis : Windows et Claude Desktop. Ni Node.js, ni Git, ni Python ne sont nécessaires.

Les fichiers sont sur la [page des releases](https://github.com/pierremndg/PII-Shield-FR/releases/latest) de ce dépôt :

- `pii-shield-fr-v2.2.0-fr.1.mcpb` : le plugin ;
- `gliner_multi_pii-v1.zip` : le modèle de détection (environ 935 Mo, soit 892 Mio, au format ONNX). C'est le modèle d'Urchade, dans la conversion ONNX publiée par [`onnx-community`](https://huggingface.co/onnx-community/gliner_multi_pii-v1), sans modification des poids. La zip a été fabriquée avec `nodejs-v2/scripts/build-model-zip.py` et contient une note d'attribution.

1. Télécharger les deux fichiers. Laisser la zip du modèle dans le dossier `Téléchargements`, sans la décompresser.
2. Dans Claude Desktop : Paramètres, Extensions, puis glisser le `.mcpb`.
3. Au premier usage, PII Shield affiche un panneau « modèle manquant ». Cliquer sur le bouton **Install downloaded ZIP** : le plugin trouve la zip dans `Téléchargements`, la vérifie et la range dans `~/.pii_shield/models/gliner_multi_pii-v1/`.
4. Redémarrer Claude Desktop.

Vérifier : demander à Claude d'anonymiser un texte de test. Les marqueurs sont en français.

**Solution de repli, sans la zip.** Le script `nodejs-v2/scripts/install-model.ps1` télécharge directement les six fichiers du modèle depuis Hugging Face (`onnx-community/gliner_multi_pii-v1`, à une version fixe du dépôt), vérifie leur empreinte SHA-256 (au moindre écart, rien n'est installé) et les range au même endroit. Le lancer à la main (`powershell -ExecutionPolicy Bypass -File install-model.ps1`) ou demander à Claude « installe le modèle PII Shield ». Il ne retélécharge rien si tout est déjà en place.

## Utiliser

1. Démarrer une nouvelle conversation dans Claude Desktop.
2. **Connecter un dossier** contenant le document (icône de dossier).
3. Demander à Claude d'anonymiser le document, avec vos mots : il appelle les outils du plugin.

> ⚠️ **Ne joignez pas le fichier directement à la conversation.** Claude Desktop enverrait son contenu à l'API : Claude verrait les données brutes avant que PII Shield puisse les traiter. Connectez un dossier : Claude ne reçoit que le chemin du fichier, et l'anonymisation se fait en local.

Claude peut ensuite ouvrir un panneau de relecture dans la conversation (outil `start_review`) : on y retire les faux positifs et on ajoute les données oubliées avant de continuer.

Pour le fonctionnement général (confidentialité, relecture, sessions de plusieurs fichiers, restauration, outils disponibles), voir [README-original.md](README-original.md). Il est en anglais ; les noms de marqueurs et le modèle y sont ceux de l'original.

## Limites connues

- Seule la version **Windows** est construite et essayée.
- Le CLI d'origine (`pii-shield`, voir `nodejs-v2/README.md`) n'est **pas couvert** : il n'a pas été testé avec les règles françaises.
- Essais faits : le plugin installé dans Claude Desktop sur la machine de l'auteur du fork, l'installation de la zip par le code du plugin dans un dossier de test, et le script de repli. **Pas encore essayé** : l'installation complète sur une machine neuve, avec le clic dans le panneau « modèle manquant ».
- Les noms de **juridictions** restent visibles par défaut ; seule la ville qui suit est masquée (réglage `PII_MASK_COURTS`, voir [FORK-FR.md](FORK-FR.md)).
- Un outil de détection ne remplace pas une relecture : vérifiez toujours le résultat avant d'envoyer un document.

## Construire soi-même

Prérequis : Node.js 22 ou plus, Git, Python 3 (pour fabriquer la zip du modèle).

1. Construire le plugin :

```bash
git clone https://github.com/pierremndg/PII-Shield-FR.git
cd PII-Shield-FR/nodejs-v2
npm ci
npm install -g @anthropic-ai/mcpb
npm run build:plugin
```

Le fichier produit est `nodejs-v2/dist/pii-shield-fr-v2.2.0-fr.1.mcpb`.

2. Fabriquer la zip du modèle : `python scripts/build-model-zip.py`, depuis `nodejs-v2`. Le script télécharge les fichiers d'`onnx-community` (environ 1,2 Go), vérifie leurs empreintes SHA-256 auprès de Hugging Face et écrit `nodejs-v2/models/gliner_multi_pii-v1.zip`, avec une note d'attribution (Urchade, Apache 2.0, conversion `onnx-community`). Cette zip est celle de la release.

Si le dépôt d'`onnx-community` disparaît : `scripts/export-gliner-colab.py` convertit soi-même les poids PyTorch d'Urchade dans Google Colab. Pour changer de modèle ou de version : `scripts/install-model.ps1` contient l'adresse du dépôt, la révision et les empreintes, et `scripts/build-model-zip.py` contient les mêmes noms de fichiers ; les mettre à jour ensemble.

## Documentation

| Fichier | Contenu |
|---|---|
| [FORK-FR.md](FORK-FR.md) | Ce que la version française change, réglages, tests, limites (technique) |
| [README-original.md](README-original.md) | README de PII Shield par gregmos, en anglais, non modifié |
| [nodejs-v2/cli/USAGE.md](nodejs-v2/cli/USAGE.md) | Manuel du CLI d'origine (non couvert par cette version) |
| [nodejs-v2/DEVELOPING.md](nodejs-v2/DEVELOPING.md) | Notes de développement d'origine |

## Crédits et licence

- **PII Shield** : gregmos (Grigorii Moskalev), licence MIT. Dépôt d'origine : https://github.com/gregmos/PII-Shield
- **Modèle** : `gliner_multi_pii-v1` par Urchade (licence Apache 2.0), conversion ONNX par onnx-community.
- **Modifications de la version française** : pierremndg, sous la même licence MIT.

Les deux mentions de copyright figurent dans [LICENSE](LICENSE).
