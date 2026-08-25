# Accordeur

Accordeur de guitare chromatique, en PWA : **pas de publicité, pas de compte, pas de
pisteur**, et ça marche hors-ligne une fois la page ouverte une première fois.

Tout tourne dans le navigateur : le son du micro est analysé sur l'appareil et n'est
jamais envoyé sur un serveur. Aucune dépendance, aucune étape de build.

## Ce que ça fait

- **Accordage à l'oreille du micro** : détection de la hauteur en continu, précision
  de l'ordre du dixième de cent sur les six cordes à vide (voir les tests).
- **Cadran ±50 cents** avec aiguille, zone juste, et couleur : bleu = trop grave,
  rouge = trop aigu, vert = juste.
- **Mode auto** : la corde visée est détectée toute seule (avec hystérésis, pour que
  la cible ne saute pas d'une corde à l'autre) — ou choix manuel en tapant une corde.
- **Conseil explicite** : « tends la corde 5 », « détends la corde 2 », « passe à la
  corde 4 » — et une coche verte sur chaque corde accordée.
- **8 accordages** : Standard, Drop D, demi-ton en bas, un ton en bas, Drop C,
  Open D, Open G, DADGAD.
- **Diapason réglable** de 415 à 465 Hz (440 par défaut), **mode strict** à ±2 cents,
  **vibration** quand la corde est juste, **note de référence** à écouter.
- **Installable** (écran d'accueil iOS/Android) et **utilisable hors-ligne**.
- L'écran ne s'éteint pas pendant l'accordage (Screen Wake Lock, si le navigateur le
  gère).

## Utilisation

Le micro exige un contexte sécurisé : `https://` ou `localhost`.

```sh
npm start            # sert le dossier sur http://127.0.0.1:8099
```

Puis ouvre <http://127.0.0.1:8099/> et autorise le micro.

Pour l'avoir sur le téléphone, héberge le dossier en HTTPS (n'importe quel
hébergement statique). Avec GitHub Pages : *Settings → Pages → Source :
GitHub Actions*, le workflow `.github/workflows/pages.yml` publie alors le dossier à
chaque push sur `main`. Sur le téléphone : ouvrir l'URL, puis « Ajouter à l'écran
d'accueil » (iOS, Safari) ou « Installer l'application » (Android, Chrome).

Conseils pour accorder : une seule corde à la fois, à vide, micro à ~20 cm de la
caisse, dans un endroit calme. Fais un accord après coup pour vérifier à l'oreille.

## Comment ça marche

| Fichier | Rôle |
| --- | --- |
| `js/pitch.js` | détection de hauteur (module pur, testable sous Node) |
| `js/tuner.js` | micro → filtres → analyseur, et note de référence |
| `js/notes.js` | conversions note ↔ fréquence, cents |
| `js/tunings.js` | les accordages |
| `js/app.js` | interface : cadran, cordes, réglages |
| `sw.js` | service worker (cache-first, mise à jour en arrière-plan) |
| `tools/make-icons.mjs` | génère les icônes PNG (rasteriseur maison, sans dépendance) |

La détection utilise la **méthode McLeod (MPM)** : fonction de différence
normalisée (NSDF), choix du premier pic significatif — c'est ce qui évite les erreurs
d'octave quand le fondamental du mi grave est faible sur un micro de téléphone — puis
interpolation parabolique pour la précision fine. Le signal passe d'abord dans un
passe-bande 55–1400 Hz, et les traitements du navigateur (AGC, réduction de bruit,
annulation d'écho) sont désactivés : ils déforment la hauteur.

En sortie, les estimations sont lissées (médiane sur 5 trames + moyenne adaptative) :
réactif quand on est loin, stable quand on approche du juste.

## Tests

```sh
npm test             # signaux synthétiques : cordes à vide, fondamental faible, bruit
```

## Licence

MIT.
