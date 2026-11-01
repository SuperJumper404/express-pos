# Apple Wallet sur staging avec Docker

Configuration installée le 1 novembre 2026 sur le serveur Docker staging `192.168.1.99`, conteneur `express_pos_app_staging`, projet Compose `backend`. La production et le serveur PM2 n'ont pas été modifiés.

## Emplacement protégé

Le répertoire `/home/vscodeserver/.smarteat/apple-wallet/staging` est indépendant du checkout backend : un reclonage du code ne supprime pas les certificats.

- `certificates/` : certificat Apple PEM, clé privée chiffrée, intermédiaire WWDR G4 et racine Apple. Montage en lecture seule dans `/run/secrets/smarteat-wallet`.
- `wallet.env` : paramètres Wallet et mot de passe de la clé, lisibles uniquement par le propriétaire sur l'hôte. Aucun secret dans Git ou Nuxt.
- `assets/` : icônes SmartEat existantes, montage persistant dans `/var/lib/smarteat/apple-wallet`. Les visuels de chaque restaurant peuvent ensuite être ajoutés dans les parcours prévus.
- `runtime/Dockerfile` : image `node:20-alpine` complétée par OpenSSL, tag `smarteat-pos-wallet:staging`. Les secrets ne font pas partie du contexte de construction.
- `compose.wallet.yml` : image, variables et montages spécifiques à Wallet.
- `compose-wallet.sh` : construit l'image et applique le Compose backend avec cet override.
- `compose-without-wallet.sh` : utilise uniquement le Compose backend d'origine pour revenir à la configuration précédente.
- `before-wallet-container.json` : sauvegarde privée de la configuration du conteneur précédent. Elle contient des variables serveur et doit rester protégée.

## Paramètres non secrets

```text
LOYALTY_WALLET_MODE=development
APPLE_WALLET_PASS_TYPE_ID=pass.fr.smarteat.loyalty
APPLE_WALLET_TEAM_ID=FV4YSAT9UL
LOYALTY_OFFERS_BASE_URL=https://staging.smarteat.fr
APPLE_WALLET_WEB_SERVICE_URL=https://api-staging.smarteat.fr/baseurl/api/v1/wallet/apple
LOYALTY_OPENSSL_PATH=/usr/bin/openssl
```

Le mode `development` signe de vraies cartes avec la mention TEST. Le fichier privé `wallet.env` contient les chemins dans le conteneur et la phrase secrète ; son contenu ne doit pas être copié dans ce document.

## Exploitation

Sur le serveur Docker staging :

```sh
/home/vscodeserver/.smarteat/apple-wallet/staging/compose-wallet.sh ps
/home/vscodeserver/.smarteat/apple-wallet/staging/compose-wallet.sh up -d --no-deps app
```

Le démarrage garde la commande existante : installation npm, migrations dbmate puis API. Aucun nouveau fichier de migration n'a été déployé pendant cette configuration ; les 52 migrations présentes étaient appliquées avant et après le redémarrage, sans migration en attente.

Pour revenir au Compose d'origine :

```sh
/home/vscodeserver/.smarteat/apple-wallet/staging/compose-without-wallet.sh up -d --no-deps app
```

Le workflow `.github/workflows/deploy-staging.yml` est adapté pour employer `compose-wallet.sh` lorsqu'il existe, avec repli sur le fonctionnement précédent ailleurs. **Cette adaptation doit être publiée sur la branche staging avant de relancer le workflow GitHub habituel**, sinon celui-ci remettrait l'image et l'environnement d'origine. La configuration Docker a été appliquée directement sur le serveur ; la publication du workflow est une opération séparée.

## Vérifications effectuées

- Clé privée déverrouillée et clé publique identique à celle du certificat Apple ; chaîne Apple valide.
- Image construite avec OpenSSL 3.5.9 et configuration Compose validée.
- Test isolé avec réseau désactivé, utilisant le véritable service Wallet du backend staging : génération `.pkpass`, vérification des empreintes du manifeste, de la signature PKCS#7 et de la chaîne jusqu'à la racine Apple. Aucune écriture SQL et aucune requête fournisseur dans ce test.
- Conteneur recréé avec la nouvelle image ; mode `development`, icônes présentes, certificat monté en lecture seule, clé lisible par le processus et correspondant au certificat.
- API publique fidélité : 401 attendu sans session. Service public Apple de recherche des mises à jour : 204 attendu pour un identifiant de test sans appareil enregistré. Canaux d'authentification client : 200.
- Zéro appareil Wallet, zéro pass Apple et zéro tâche Wallet avant activation ; aucun message client envoyé par cette mise en place.

L'installation sur iPhone, l'enregistrement réel d'un appareil et APNs restent à tester avec un compte de démonstration. La version actuellement déployée sur le serveur est `cf3fe7b` : les derniers ajouts caisse/borne, visuels administrables et campagnes de cette copie de travail n'ont pas été déployés par cette configuration de certificats.
