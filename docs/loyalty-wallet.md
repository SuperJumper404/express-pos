# Fidélité : Apple Wallet et Google Wallet

La base SmartEat reste la source de vérité. Apple et Google affichent la même adhésion et le même QR opaque ; ils ne créent pas de compte ou de solde supplémentaire. Le QR ne remplace jamais une session web. Le lien « Voir mes offres » ouvre `/compte/fidelite?shopId=...`, où une session authentifiée est requise. Ce lien ne transporte ni jeton de connexion ni ancienne table.

## Installation serveur

1. Appliquer les migrations fidélité puis `20261024141000_loyalty_wallet.sql` sur une base de développement avant toute mise en service. Cette implémentation n'exécute pas les migrations automatiquement.
2. Copier les paramètres de `.env.loyalty.example` dans l'environnement serveur protégé. Le mode par défaut est `disabled` : ajouter une carte renvoie une erreur 503 explicite, jamais un faux succès.
3. Configurer `LOYALTY_OFFERS_BASE_URL` et `APPLE_WALLET_WEB_SERVICE_URL` avec des URL HTTPS publiques. Dans ce dépôt, le second est la racine `/baseurl/api/v1/wallet/apple`, sans `/v1` final. Adapter uniquement si le proxy public réécrit explicitement ce préfixe.
4. Exécuter la maintenance Wallet chaque minute. Elle prend des tâches SQL après commit, communique avec les fournisseurs hors transaction commande et réessaie après 30 s, 60 s, etc. (maximum 24 h). Les erreurs stockées sont des codes génériques sans jeton ni réponse fournisseur. Un bail protège les tâches reprises après interruption ; le travail bloqué depuis 15 minutes peut être repris. Une panne Wallet ne doit pas faire échouer un paiement.

Le mode `development` produit de vraies cartes signées avec la mention TEST si les accès sont fournis ; Google impose également ses restrictions Demo Mode. Sans accès, aucun lien Google ni pass Apple factice n'est fourni. Ne fournir des accès de production qu'après validation explicite.

## Apple

Fournir Pass Type ID, Team ID, certificat PEM associé au Pass Type ID, clé privée PEM (passphrase possible), certificat intermédiaire WWDR PEM actuel, et un répertoire d'images PNG contenant `icon.png` et `icon@2x.png`. `icon@3x.png` et les logos sont facultatifs. OpenSSL doit être installé sur le serveur et accessible via `LOYALTY_OPENSSL_PATH` ; aucune dépendance npm supplémentaire n'est ajoutée.

Le serveur génère le SHA-1 des fichiers, signe le manifeste au format PKCS#7 détaché et distribue l'archive ZIP `.pkpass`. La paire Pass Type ID / numéro de série reste stable. Le jeton d'authentification Apple est généré indépendamment du QR et des sessions, reste côté serveur et dans le pass, et ne change pas lors des mises à jour.

Le protocole expose : enregistrement et désenregistrement des appareils authentifiés par `ApplePass`, liste des numéros mis à jour (identifiant opaque de bibliothèque appareil), téléchargement authentifié du nouveau pass, réception des diagnostics sans les enregistrer. Les appareils enregistrés reçoivent une notification APNs vide avec le certificat du pass ; APNs utilise son environnement de production, conformément au protocole Wallet. La suppression du pass retire seulement l'enregistrement appareil, pas l'adhésion.

Les étiquettes de mise à jour proviennent d'un compteur SQL global verrouillé jusqu'au commit de la création ou modification du pass. Deux cartes modifiées dans la même milliseconde reçoivent des étiquettes distinctes et ordonnées ; une carte réajoutée conserve son identité et son étiquette. Le solde affiché conserve les points réservés, mais les récompenses annoncées disponibles et le prochain palier sont calculés avec le solde disponible après réservations.

La personnalisation Apple utilise le nom et les couleurs du programme. Les images viennent du répertoire serveur validé, pas d'un téléchargement arbitraire de `logoUrl` : préparer les logos serveur requis avant mise en service. Pour plusieurs restaurants, placer les images dans `APPLE_WALLET_ASSETS_PATH/SHOPID/` : les fichiers de ce répertoire sont prioritaires, avec repli vers les icônes communes du répertoire racine. Les fichiers ne sont jamais choisis à partir d'un chemin fourni par le navigateur.

## Extension caisse, borne et administration

La confirmation de récompense identifiée transporte aussi `loyalty_expected_points_cost` et `loyalty_program_version`, avec adhérent, offre et remise attendue. Le serveur vérifie le coût et la version sous le verrou de la transaction avant réservation ; ces valeurs participent à l'idempotence. Mettre à jour frontend/backend ensemble et recharger les anciens écrans en cache. Une confirmation incomplète est refusée avant tout paiement.

Après les migrations fidélité existantes, appliquer dans l'ordre `20261101120000_loyalty_card_numbers.sql`, `20261101121000_loyalty_marketing_consent.sql`, `20261101122000_loyalty_wallet_assets.sql`, `20261101123000_loyalty_wallet_campaigns.sql` sur une base de développement. Aucun lancement automatique.

L'adhésion exige une session client et une preuve signée de table active du même restaurant (`X-Table-Session`), plus CSRF. Caisse et borne retrouvent uniquement des adhésions existantes, sans OTP et sans fabriquer de session personnelle. Les quotas SQL sont de 30/minute par borne, 60/minute par membre du personnel ; l'identifiant d'acteur est haché.

Pour les anciennes cartes : `node scripts/backfill-loyalty-card-numbers.js` avec `LOYALTY_BACKFILL_DATABASE_URL` explicitement définie. Le script est reprenable et préserve QR/soldes ; la lecture attribue aussi les numéros manquants et synchronise Wallet.

L'administration publie des variantes PNG contrôlées dans `APPLE_WALLET_ASSETS_PATH/SHOPID/VERSION/` : logo 160×50, 320×100, 480×150 ; bandeau 375×144, 750×288, 1125×432 pixels. Apple peut adapter le cadrage. Les icônes communes restent requises côté serveur, les images précédentes servent de repli. Conserver les anciennes versions jusqu'à vérification des références et sauvegarde. Les fichiers orphelins après échec incertain peuvent être nettoyés ultérieurement.

Les campagnes Apple sont limitées à 200 caractères et un envoi par restaurant toutes les cinq minutes. Un brouillon fige l'audience consentante enregistrée ; une confirmation met les destinataires en attente. Requêtes et confirmations répétées sont idempotentes. Le worker vérifie encore la version du consentement et l'enregistrement avant de changer le message du pass existant. Un retrait de consentement efface le message ; se réinscrire ne réactive pas une ancienne campagne.

La maintenance minute traite aussi `loyalty_wallet_campaign_recipients` : bail de 15 minutes, reprise progressive de 30 secondes à 24 heures, 20 destinataires par passage. Surveiller statut, tentatives, prochaine reprise et erreur générique. `processed` signifie synchronisation traitée, pas alerte affichée ou lue. Les points restent indépendants.

## Google (fonctionnement existant)

Créer l'émetteur dans Google Pay & Wallet Console, activer Wallet API et autoriser le compte de service. Fournir Issuer ID, adresse du compte de service, fichier de clé privée PEM protégé et origines web autorisées. Le logo du programme doit être une URL HTTPS publique. La classe est `ISSUER.smarteat_SHOP`, l'objet `ISSUER.smarteat_SHOP_SERIAL` ; un changement de points met à jour l'objet existant par PATCH.

Le serveur utilise un jeton OAuth signé RS256, crée ou met à jour les ressources Loyalty officielles, puis signe un JWT `savetowallet` d'une heure. La revue de classe n'est pas remise à zéro lors d'un PATCH. L'obtention de l'accès de publication et l'approbation des classes restent nécessaires. Le lien d'ajout est personnel à la carte mais ne donne aucun accès au compte SmartEat.

## Vérifications

Tests sans communication externe : `node test/loyalty-wallet.test.js`, `node test/loyalty-wallet-tags.test.js`, `node test/loyalty-wallet-signing.test.js`, `node test/loyalty-wallet-routes.test.js`, `node test/loyalty-wallet-worker.test.js`. Ils vérifient les charges utiles, signatures JWT, archive, identifiants stables, étiquettes multi-cartes à horloge identique, erreurs fournisseur, authentification Apple, enregistrement/désenregistrement et reprises de tâches. Le test de signature crée un certificat local autosigné et vérifie réellement la signature PKCS#7 avec OpenSSL ; cela ne valide pas la chaîne de certification Apple ni l'installation iPhone.

Les badges d'ajout doivent provenir des fournisseurs. [Google fournit une archive SVG publique](https://developers.google.com/static/wallet/download-assets/add-to-wallet-svg.zip). Le téléchargement des badges Apple requiert l'acceptation par le titulaire du [Wallet Marketing Artwork License Agreement](https://developer.apple.com/wallet/add-to-apple-wallet-guidelines/index.html) ; aucun accord juridique n'est accepté automatiquement par cette implémentation.

À vérifier sur une base SQL de développement : migrations, clés étrangères, compétition entre workers et reprise après arrêt. À vérifier sur de vrais téléphones : signature et chaîne Apple, ajout/réajout du même pass, APNs et mises à jour écran verrouillé, installation Google en Demo Mode puis classe approuvée, lien « Voir mes offres » sans session, suppression d'une carte sans suppression du compte, même adhésion sur les deux Wallet. Aucun téléphone ni accès fournisseur réel n'a été utilisé pour les tests automatisés.

Surveiller les tâches `pending` avec `attempts>0`, `next_attempt_at`, et celles `processing` dont le bail est ancien. Ne pas exporter `auth_token`, `push_token` ni les diagnostics appareils vers les journaux. Les tâches terminées peuvent être purgées selon la politique de rétention ; le journal de points reste indépendant.

## Références officielles consultées

- [Apple : construction et signature d'un pass](https://developer.apple.com/documentation/walletpasses/building-a-pass)
- [Apple : protocole de mise à jour et APNs](https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes)
- [Google : création des classes et objets](https://developers.google.com/wallet/retail/loyalty-cards/use-cases/create)
- [Google : objets Loyalty](https://developers.google.com/wallet/reference/rest/v1/loyaltyobject)
- [Google : JWT et ajout au Wallet](https://developers.google.com/wallet/retail/loyalty-cards/use-cases/jwt)
