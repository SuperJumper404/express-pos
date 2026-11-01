# Apple Wallet sur staging avec Docker

Configuration installée le 1 novembre 2026 sur le serveur Docker staging `192.168.1.99`, conteneur `express_pos_app_staging`, projet Compose `backend`. La production et le serveur PM2 n'ont pas été modifiés.

## Emplacement protégé

Le répertoire `/home/vscodeserver/.smarteat/apple-wallet/staging` est indépendant du checkout backend : un reclonage du code ne supprime pas les certificats.

- `certificates/` : certificat Apple PEM, clé privée chiffrée, intermédiaire WWDR G4 et racine Apple. Montage en lecture seule dans `/run/secrets/smarteat-wallet`.
- `wallet.env` : paramètres Wallet, mot de passe de la clé et secret indépendant d'authentification client, lisibles uniquement par le propriétaire sur l'hôte. L'origine client autorisée est `https://staging.smarteat.fr`. Aucun secret dans Git ou Nuxt.
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

Le démarrage garde la commande existante : installation npm, migrations dbmate puis API. La première configuration des certificats conservait les 52 migrations existantes. Le déploiement complet de la feature a ensuite appliqué quatre migrations supplémentaires : 56 appliquées et aucune en attente.

Pour revenir au Compose d'origine :

```sh
/home/vscodeserver/.smarteat/apple-wallet/staging/compose-without-wallet.sh up -d --no-deps app
```

Le workflow `.github/workflows/deploy-staging.yml` est adapté pour employer `compose-wallet.sh` lorsqu'il existe, avec repli sur le fonctionnement précédent ailleurs. L'adaptation est publiée sur la branche staging et son contenu a été relu via l'API GitHub : [commit `efe81e1`](https://github.com/SuperJumper404/express-pos/commit/efe81e1dc9e58312333d3c831f99c57fc5ff0521). Les prochains déploiements Docker conserveront ainsi l'image, les paramètres et les montages Wallet. Le workflow utilise un déclenchement manuel ; les exécutions du déploiement complet sont référencées ci-dessous.

## Vérifications effectuées

- Clé privée déverrouillée et clé publique identique à celle du certificat Apple ; chaîne Apple valide.
- Image construite avec OpenSSL 3.5.9 et configuration Compose validée.
- Test isolé avec réseau désactivé, utilisant le véritable service Wallet du backend staging : génération `.pkpass`, vérification des empreintes du manifeste, de la signature PKCS#7 et de la chaîne jusqu'à la racine Apple. Aucune écriture SQL et aucune requête fournisseur dans ce test.
- Conteneur recréé avec la nouvelle image ; mode `development`, icônes présentes, certificat monté en lecture seule, clé lisible par le processus et correspondant au certificat.
- API publique fidélité : 401 attendu sans session. Service public Apple de recherche des mises à jour : 204 attendu pour un identifiant de test sans appareil enregistré. Canaux d'authentification client : 200.
- Zéro appareil Wallet, zéro pass Apple et zéro tâche Wallet avant activation ; aucun message client envoyé par cette mise en place.

## Déploiement complet du 1 novembre 2026

Les commits propres à la feature ont été intégrés sur les dernières branches staging, en conservant les changements déjà présents. Les instantanés de travail préexistants n'ont pas été transférés.

- Backend exécuté : `7c27fb669c599e1db49f865d117ca4bd3eaa5d62`, [déploiement Docker réussi](https://github.com/SuperJumper404/express-pos/actions/runs/41353591265).
- Frontend exécuté : `ea2014eee79b8d1d4c069fe51a8ff399377c074c`, [déploiement Docker réussi](https://github.com/SuperJumper404/pos-app/actions/runs/41353730270).
- Les jobs PM2 ont été ignorés. Les deux conteneurs fonctionnent sans redémarrage après démarrage.
- Sauvegarde privée vérifiée avant déploiement : `/home/vscodeserver/.smarteat/backups/loyalty-staging-20261101-89a54005`, avec base SQL, sources et configuration des conteneurs. Ces archives contiennent des paramètres privés et ne doivent pas être publiées.
- Suites générales et fidélité frontend/backend réussies, génération statique staging réussie, lint frontend sans erreur (162 avertissements existants).
- Intégration réelle MySQL 8 réussie dans une base jetable, notamment réservations concurrentes, transactions, remboursement/rollback, remise borne et consentement des campagnes. Le staging contient 56 migrations appliquées, aucune en attente.
- Le HTML public correspond exactement au fichier généré dans le conteneur (`SHA-256 ab22f06255ba422a1ad442ea545fd998162291ae6a3d3e104f6c3ec711bab7be`) ; les bundles sont servis en HTTP 200 et contiennent les nouveaux écrans et la configuration API staging.
- Contrôle navigateur de `https://staging.smarteat.fr/fidelite` : redirection normale vers la page de connexion, formulaire visible. Aucun contournement d'authentification ni compte créé.
- CORS client validé avec l'origine staging et les en-têtes de session/CSRF ; les routes administratives restent protégées (401 sans session).
- Avec le code réellement déployé et les certificats montés, génération d'une carte en mémoire et vérification du manifeste, de la signature et de la chaîne Apple réussies. Dépôt fictif, aucune écriture SQL ni requête fournisseur ; aucun pass client créé.

Conformément au choix de l'utilisateur, le restaurant `demo` reste sans programme configuré. Aucun client, offre, solde ou campagne de démonstration n'a été ajouté. L'utilisateur configure et active le programme dans l'onglet Fidélité avant son essai depuis un QR de table.

Les cartes portent la mention TEST. L'installation sur iPhone, l'enregistrement réel d'un appareil et la réception APNs restent à vérifier par ce parcours. Aucune notification, aucun SMS et aucun paiement réel n'ont été déclenchés par le déploiement. Les commits ultérieurs de documentation ne nécessitent pas de redéploiement et ne changent pas les révisions exécutées indiquées ci-dessus.
