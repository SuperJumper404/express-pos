# Apple Wallet : production Docker

Configuration installée et vérifiée le 10 novembre 2026 pour
`https://caisse.smarteat.fr`. Le frontend et le backend ont été déployés avec
Docker sur staging puis en production. Les jobs PM2 n'ont pas été exécutés.

## Configuration persistante

Le répertoire protégé `/home/smarteatprod/.smarteat/apple-wallet/production`
reste hors du checkout applicatif :

- `wallet.env` contient les paramètres et secrets de production, en mode `600`.
- `releases/certificates-20261110/certificates` contient le certificat, la clé
  privée chiffrée, WWDR G4 et la racine Apple. Montage en lecture seule dans
  `/run/secrets/smarteat-wallet` ; aucun certificat ni secret dans l'image ou Git.
- `assets` conserve les visuels de chaque restaurant ; montage persistant en
  lecture/écriture dans `/var/lib/smarteat/apple-wallet`.
- `releases/certificates-20261110/runtime/Dockerfile` construit l'image
  `smarteat-pos-wallet:production`, basée sur Node 20 avec OpenSSL.
- `compose.wallet.yml` et `compose-wallet.sh` appliquent ces paramètres. Le
  workflow Docker de production existant utilise ce wrapper à chaque déploiement.

Les identifiants publics sont `pass.fr.smarteat.loyalty` et `FV4YSAT9UL`.
Le certificat expire le 1 décembre 2027 à 20:28:45 UTC.

| Paramètre | Production |
| --- | --- |
| `LOYALTY_WALLET_MODE` | `production` |
| `APPLE_WALLET_WEB_SERVICE_URL` | `https://api.smarteat.fr/baseurl/api/v1/wallet/apple` |
| `LOYALTY_OFFERS_BASE_URL` | `https://caisse.smarteat.fr` |
| Origines client autorisées | `https://caisse.smarteat.fr`, `https://app.smarteat.fr` |
| Proxy autorisé | `192.168.1.61`, observé sur les connexions de requêtes HTTPS publiques |

Le secret client de production est indépendant de celui du staging. Les secrets
restent sur les serveurs, protégés, et ne sont pas reproduits dans ce document.
Le staging conserve le mode `development` et la mention TEST ; la production
génère des cartes sans cette mention.

## Déploiements et contrôles

| Environnement | Backend | Frontend |
| --- | --- | --- |
| Staging | [42843603291](https://github.com/SuperJumper404/express-pos/actions/runs/42843603291) | [42843610528](https://github.com/SuperJumper404/pos-app/actions/runs/42843610528) |
| Production | [42845624638](https://github.com/SuperJumper404/express-pos/actions/runs/42845624638) | [42845630840](https://github.com/SuperJumper404/pos-app/actions/runs/42845630840) |

Révisions exécutées dans les deux environnements : backend
`d2836473872f9e65f8145b3e0df65e3b487d3d50`, frontend
`1f30b75c147f6834cc2d1dfaea0ee569f868a0f3`.

- Suites générales et fidélité frontend/backend réussies.
- Clé privée identique à la clé du certificat, chaîne Apple valide, UID du Pass
  Type ID et OU de l'équipe vérifiés exactement ; échéance vérifiée.
- Signature réelle d'une carte en mémoire, dans Docker sans réseau, avec dépôt
  fictif sans SQL. Manifeste, signature PKCS7 et chaîne Apple vérifiés. L'outil
  PKCS7 utilise `-purpose any` car le certificat Wallet n'est pas un certificat
  de messagerie S/MIME ; les contrôles de chaîne, identité et signature restent
  effectués.
- API administrative : `appleWalletAvailable=true`. Parcours téléphone HTTPS
  et session/CSRF vérifiés sans créer de client ; origine étrangère refusée et
  faux HTTPS depuis un hôte direct non autorisé refusé.
- Recherche Apple des mises à jour : HTTP 204 pour un appareil inexistant.
- HTML public identique au fichier généré dans chaque conteneur ; trois scripts
  frontend servis en HTTP 200. Les deux API ont zéro redémarrage après démarrage.
- 60 migrations appliquées dans chaque environnement.
- Contrôle visuel de Carte Wallet sur la caisse : formulaire disponible,
  avertissement de configuration Apple absent. Programme laissé dans son état
  choisi par le restaurateur.

Aucun compte, point, offre, carte client, campagne, SMS, paiement ou notification
n'a été créé par les vérifications. L'ajout sur un iPhone et la réception d'une
notification restent des essais physiques à effectuer par le restaurateur.
L'adhésion reste accessible depuis le QR d'une table sur le téléphone du client.

## Sauvegardes et retour arrière

Configuration Wallet précédente :
`/home/smarteatprod/smarteat-backups/wallet-certificates-20261110-151229`.
Le script privé `rollback-wallet.sh` restaure uniquement la configuration Wallet
précédente et recrée l'application ; les visuels sont conservés.

Les workflows ont également sauvegardé les sources, fichiers d'environnement
et base SQL avant le déploiement. Ces sauvegardes sont privées :

- Backend production : `/home/smarteatprod/smarteat-backups/backend-20261110-153353-874992`.
- Frontend production : `/home/smarteatprod/smarteat-backups/frontend-20261110-153356-875220`.
- Backend staging : `/home/vscodeserver/smarteat-backups/backend-20261110-152219-2195545`.
- Frontend staging : `/home/vscodeserver/smarteat-backups/frontend-20261110-152222-2195782`.

Une restauration applicative ou SQL constitue une opération distincte du retour
arrière Wallet. Ne pas publier les archives, environnements ou fichiers privés.
