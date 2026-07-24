# Déploiement des personnalisations produit V2

Ce document décrit le premier déploiement du modèle V2. La migration est
additive : les tables historiques restent présentes et l'adaptateur legacy ne
doit pas être retiré pendant cette phase.

## Décision de mise en production

Le déploiement doit être interrompu si l'un des contrôles suivants échoue :

- la sauvegarde n'est pas restaurable sur un environnement de contrôle ;
- `npm test` échoue avec le runtime backend cible ;
- `node scripts/verify-customization-v2.js` sort avec un code non nul ;
- le répertoire d'images n'est pas persistant et accessible en écriture ;
- un parcours legacy échoue avant le déploiement du frontend V2.

Le compose backend utilise Node 20. La suite complète a été exécutée avec
Node `v20.20.2`. Le mode PM2 doit afficher une version Node 20 compatible avant
le déploiement (`node --version`). Node 18 n'est pas une cible backend prise en
charge : avec l'arbre de dépendances actuel, `nanoid@5` ne peut pas être chargé
par `require()` sous Node 18.

## Variables et stockage d'images

Définir explicitement dans l'environnement backend :

```dotenv
STRIPE_STOCK_RESERVATION_MINUTES=15
PUBLICIMAGEPATH=/home/smarteat/public
```

Les images des choix simples sont stockées dans :

```text
${PUBLICIMAGEPATH}/customization-choices
```

Ce dossier doit exister, être accessible en lecture/écriture par le processus
Node et être monté sur un volume persistant. Le backend le crée au démarrage si
nécessaire et l'expose sous `/api/v1/imgcustomizations/:filename`. Le volume
`public_uploads:/home/smarteat/public` du compose couvre ce besoin lorsque
`PUBLICIMAGEPATH=/home/smarteat/public`.

Avant le déploiement :

```sh
test -n "$PUBLICIMAGEPATH"
mkdir -p "$PUBLICIMAGEPATH/customization-choices"
test -w "$PUBLICIMAGEPATH/customization-choices"
test "${STRIPE_STOCK_RESERVATION_MINUTES}" = "15"
```

## Préparation et sauvegarde

1. Geler les écritures administratives sur les produits et personnalisations.
2. Identifier le commit backend et le commit frontend à déployer.
3. Vérifier que le backend s'exécute sous Node 20.
4. Faire une sauvegarde MySQL complète, horodatée et chiffrée.
5. Tester la restauration de cette sauvegarde sur une base isolée.
6. Sauvegarder le volume `${PUBLICIMAGEPATH}` séparément.
7. Exécuter la migration et le vérificateur sur une copie réaliste avant la
   base staging partagée.

## Migration et vérification

Depuis le dépôt backend, après chargement de l'environnement cible :

```sh
set -a
. ./.env.staging
set +a
npm ci --include=dev
npm test
npm run db:up:staging
ENV_FILE=.env.staging node scripts/verify-customization-v2.js
```

Pour une validation locale :

```powershell
npm.cmd test
npm.cmd run db:up:local
node scripts/verify-customization-v2.js
```

Le vérificateur doit signaler :

- des deltas de groupes et de choix égaux à zéro ;
- `Invalid min/max rows: 0` ;
- `Missing product associations: 0` ;
- `Invalid choice associations: 0` ;
- `Unresolved active-order selections: 0` ;
- `Customization V2 verification passed` et un code de sortie `0`.

Les sélections d'archives legacy déjà absentes sont uniquement informatives :
elles ne peuvent pas être reconstruites. Ne pas les synthétiser.

## Blocage observé sur la base locale le 24 juillet 2026

La migration `20260724120000` est appliquée localement, mais le vérificateur
sort avec le code `1` : 22 groupes legacy, 16 étapes partagées et 22
associations produit-étape. Six groupes référencent des produits absents :

| Groupe legacy | Produit absent | Choix legacy | Sélections de commande |
| ---: | ---: | ---: | ---: |
| 84 | 34 | 3 | 0 |
| 85 | 1 | 0 | 0 |
| 86 | 1 | 0 | 0 |
| 87 | 1 | 0 | 0 |
| 88 | 1 | 0 | 0 |
| 89 | 3 | 0 | 0 |

Ces six associations V2 pointent aussi vers six étapes partagées absentes ;
les trois choix du groupe 84 sont donc rattachés à une étape inexistante. Le
reste des contrôles locaux est sain : 49 choix legacy/partagés/contextuels,
aucun min/max invalide, aucun choix inter-étape, aucun produit lié d'une autre
boutique et aucune sélection active non résolue.

Avant tout déploiement sur une base présentant ces lignes, un propriétaire des
données doit décider, groupe par groupe, de restaurer le produit d'origine, de
fournir une correspondance métier explicite vers un produit valide, ou de
supprimer intentionnellement le groupe et ses choix après sauvegarde et audit.
Il ne faut ni réassigner ni supprimer automatiquement ces données. Après la
correction approuvée, rejouer la migration sur une copie restaurée ou réparer
les lignes V2 avec un script revu, puis exiger un vérificateur entièrement vert.

## Ordre de déploiement staging

1. **Sauvegarde** MySQL et volume d'images, puis preuve de restauration.
2. **Migration** additive `20260724120000_customization_steps_v2.sql`.
3. **Vérificateur** V2 ; arrêter immédiatement sur un code non nul.
4. **Backend V2** avec l'adaptateur legacy et la tâche de libération des
   réservations expirées.
5. **Smoke legacy** : catalogue, création/édition produit, commande non-Stripe,
   Stripe, détail, archive et ticket avec l'ancien frontend.
6. **Frontend V2** uniquement après validation des cinq étapes précédentes.
7. **Smoke V2** complet, puis observation des commandes, stocks, paiements,
   réservations, instantanés et images.

Le nouveau frontend ne doit jamais être déployé avant le backend compatible.

## Surveillance après déploiement

Surveiller au minimum :

- les réponses `409` de repricing, disponibilité, stock et idempotence ;
- les réservations `reserved` dépassant leur expiration ;
- les mouvements de stock parent et produit lié ;
- les erreurs de création, lecture ou suppression des images ;
- la présence des instantanés sur les détails actifs et archivés ;
- les succès, annulations, échecs et paiements au comptoir Stripe.

## Retour arrière et limite destructive

Le retour arrière recommandé est :

1. arrêter le déploiement du frontend V2 ou remettre le frontend précédent ;
2. conserver le backend V2 et le schéma additif pour continuer à traiter les
   réservations Stripe et lire les instantanés déjà créés ;
3. corriger le backend en avant si le problème se situe dans le cycle de stock ;
4. ne revenir au backend précédent qu'après avoir résolu toutes les
   réservations `reserved` et validé l'impact sur les commandes V2.

La commande `dbmate down` supprime les sept tables V2, les deux colonnes
d'idempotence et leur index. Elle est donc destructive dès qu'une étape, une
image référencée, une commande, un instantané ou une réservation V2 a été créé.
Après la première écriture V2, ne pas exécuter le `down` : restaurer la
sauvegarde complète lors d'un retour arrière global, ou garder le schéma
additif et revenir seulement sur le frontend.

Avant toute écriture V2, un rollback de migration n'est acceptable que sur une
base sauvegardée, avec le frontend V2 arrêté et après validation explicite :

```sh
dbmate --migrations-dir=db/migrations down
```

Ne pas retirer les tables legacy, la projection `product_customization` ni les
écritures de compatibilité dans ce déploiement. Leur retrait nécessite un plan
distinct après observation en production.
