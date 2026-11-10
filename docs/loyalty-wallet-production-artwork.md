# Stockage des visuels Wallet en production

Le 10 novembre 2026, la publication depuis `https://caisse.smarteat.fr` renvoyait
`503 LOYALTY_WALLET_NOT_CONFIGURED` : le conteneur de production ne recevait ni
`APPLE_WALLET_ASSETS_PATH`, ni montage persistant pour les images.

## Configuration appliquée

Le conteneur `express_pos_app_production` utilise désormais :

- `APPLE_WALLET_ASSETS_PATH=/var/lib/smarteat/apple-wallet` ;
- un montage en lecture/écriture depuis
  `/home/smarteatprod/.smarteat/apple-wallet/production/assets`.

Le répertoire protégé `/home/smarteatprod/.smarteat/apple-wallet/production`
contient `wallet.env`, `compose.wallet.yml` et `compose-wallet.sh`. Il reste hors
du checkout applicatif. Le workflow de production existant utilise déjà ce
wrapper lorsqu'il est présent, ce qui conserve les images après un déploiement.
Les workflows normaux de staging et de production sont conservés ; le workflow
temporaire de diagnostic n'est pas le workflow de déploiement final.

Le modèle versionné [compose.wallet-artwork.yml](../compose.wallet-artwork.yml)
reproduit uniquement le stockage. Pour l'utiliser dans un environnement sans
override Wallet existant, créer le dossier persistant puis fournir son chemin :

```sh
export WALLET_ARTWORK_HOST_PATH=/home/smarteatprod/.smarteat/apple-wallet/production/assets
docker compose --env-file .env.production -f compose.yml -f compose.wallet-artwork.yml config --quiet
docker compose --env-file .env.production -f compose.yml -f compose.wallet-artwork.yml up -d --no-deps app
```

Ne pas empiler ce modèle avec l'override Wallet privé existant : celui-ci contient
déjà le montage. Conserver l'override complet lorsqu'il gère aussi les certificats.
Le modèle ne contient aucune clé, aucun certificat et aucun secret.

## Vérifications et limite

- Avant correction, une lecture authentifiée d'un visuel inexistant renvoyait
  `503 LOYALTY_WALLET_NOT_CONFIGURED` ; après correction, elle renvoie
  `404 LOYALTY_NOT_FOUND`.
- Stockage accessible en écriture depuis le conteneur, API publique en HTTP 200,
  accès aux visuels sans authentification refusé en HTTP 401.
- Les quatre tests `test/loyalty-wallet-assets.test.js` passent dans le conteneur
  de production, dont la publication, la conservation des variantes et les routes
  d'import administrateur.
- Source applicative exécutée inchangée : `e52806b7cccb449e227f1c227f433a2e9c3653df`.

Cette correction permet de publier les visuels. La signature des cartes Apple
reste désactivée en production : les certificats et les paramètres de création
des cartes devront être installés séparément. Aucune carte client, campagne,
notification, récompense ou écriture de points n'a été créée par la correction.

## Retour arrière

La configuration précédente du conteneur et le fichier d'environnement ont été
sauvegardés dans
`/home/smarteatprod/smarteat-backups/wallet-storage-20261110-131601`.
Le script privé `rollback.sh` de ce dossier recrée uniquement l'application avec
le Compose de base et désactive le wrapper. Les images restent conservées dans
le dossier persistant. Ne pas publier les fichiers de cette sauvegarde, qui
contiennent des paramètres privés.
