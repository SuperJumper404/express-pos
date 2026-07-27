# TVA par produit — design

## Objectif

Gérer la TVA au niveau de chaque produit, tout en conservant le prix actuellement saisi et affiché comme un prix TTC.

Un restaurant pourra choisir un taux de **5,5 %**, **10 %** ou **20 %** par produit. La caisse, Stripe et les clients continuent toujours à manipuler le total TTC. La ventilation HT/TVA est calculée par le serveur et conservée dans chaque ligne de commande afin que les archives restent fiscalement exactes après une modification ultérieure du produit.

## Règles métier validées

- Le prix du produit est un prix TTC. Exemple : une pizza saisie à `10,00 €` avec une TVA de `10 %` coûte bien `10,00 €` au client.
- Les taux autorisés sont exclusivement `5,5 %`, `10 %` et `20 %`.
- Un produit a un seul taux à la fois ; le choix dans le formulaire sera donc exclusif (boutons radio), pas trois cases indépendantes.
- Tous les suppléments et personnalisations d'une ligne héritent du taux du produit principal, puisqu'ils font déjà partie de son prix de ligne TTC.
- Les montants envoyés à Stripe ne changent pas : Stripe reçoit le total TTC calculé aujourd'hui.
- Les commandes existantes et les produits existants gardent leurs montants TTC inchangés et sont initialisés à `10 %`.

## Calcul des montants

Le calcul est réalisé côté backend, à partir du total TTC de chaque ligne validé par le serveur.

Pour une ligne au taux `r` :

```txt
HT = arrondi(TTC / (1 + r / 100))
TVA = TTC - HT
```

L'arrondi est fait **par ligne de commande en centimes** ; les totaux de commande sont la somme des lignes. Cette règle évite les écarts liés aux nombres flottants et garantit que `HT + TVA = TTC` à chaque ligne.

Exemple validé :

```txt
Pizza : 10,00 € TTC, TVA 10 %
HT    : 9,09 €
TVA   : 0,91 €
TTC   : 10,00 €
```

## Données

### Produits

Ajouter un champ `vat_rate` sur `products` :

- type décimal adapté aux valeurs `5.50`, `10.00`, `20.00` ;
- non nul ;
- valeur par défaut `10.00` ;
- validation applicative stricte sur les trois taux autorisés.

La valeur est lue lors de la création ou de la modification d'une commande, mais un changement ultérieur de produit ne doit jamais réécrire une commande existante.

### Lignes actives et archivées

Conserver un snapshot fiscal sur `orderdetail` et `archivesdetail` :

- `vat_rate` : taux appliqué à la ligne ;
- `unit_price_ht` : montant HT unitaire ;
- `unit_vat` : TVA unitaire ;
- `total_ht` : total HT de la ligne ;
- `total_vat` : TVA totale de la ligne.

Les champs TTC existants (`price`, `total`, sous-total de commande) restent la référence commerciale et ne changent pas de sens.

Cette duplication est volontaire : une archive doit pouvoir produire son ticket, sa ventilation TVA et ses exports sans dépendre du produit actuel.

## Backend

### Produits

- Les contrôleurs et modules de création/modification acceptent `vat_rate`.
- Si le client ne fournit pas de taux à la création, le backend applique `10 %`.
- Toute valeur hors `5.5`, `10` ou `20` est rejetée par une erreur de validation explicite.

### Devis, création et modification de commandes

- Le moteur de devis récupère le taux du produit en même temps que son prix et ses personnalisations.
- Après le calcul existant du TTC, il calcule les snapshots HT/TVA en centimes.
- La création de commande et la modification de commande enregistrent ces snapshots dans `orderdetail`.
- L'archivage copie les snapshots depuis la commande active vers `archivesdetail` ; il ne recalcule pas la TVA avec le produit actuel.
- Le paiement Stripe, les remboursements, l'autorisation et la capture continuent de se baser sur le TTC existant.

### Lecture et reporting

Les réponses de détail de commande et d'archive exposent les montants fiscaux des lignes ainsi qu'une ventilation groupée par taux :

```txt
Taux  | Total HT | TVA | Total TTC
5,5 % | …        | …   | …
10 %  | …        | …   | …
20 %  | …        | …   | …
```

Les rapports qui affichent des montants fiscaux utilisent les snapshots archivés. Les statistiques de chiffre d'affaires continuent à utiliser les montants TTC actuels, sauf lorsqu'un indicateur HT/TVA est explicitement demandé.

## Frontend

### Formulaire produit

Sous le champ de prix, ajouter un groupe radio Vuetify intitulé `Taux de TVA` :

- `5,5 %` ;
- `10 %` ;
- `20 %`.

Le taux `10 %` est présélectionné lors de la création d'un produit. Le formulaire rappelle que le champ prix est exprimé en TTC. L'édition préremplit le taux enregistré.

### Panier, commandes et ticket

- Le panier, les écrans de paiement et les montants des lignes restent affichés TTC pour ne pas perturber le flux caisse/client.
- Le détail d'une commande, le ticket et les vues d'archive affichent en bas une ventilation TVA par taux quand la TVA est activée pour la boutique.
- Aucun total Stripe ou libellé de paiement n'est modifié par l'ajout de cette ventilation.

## Migration et compatibilité

Une migration SQL unique devra :

1. ajouter `products.vat_rate` et initialiser tous les produits à `10.00` ;
2. ajouter les snapshots fiscaux à `orderdetail` et `archivesdetail` ;
3. initialiser les lignes existantes à `10 %` ;
4. calculer leurs HT/TVA depuis leurs totaux TTC déjà stockés, sans modifier les prix, totaux ou paiements ;
5. rendre les nouvelles colonnes non nulles après le backfill.

Les commandes historiques sans personnalisation identifiable restent cohérentes : elles sont considérées à `10 %`, conformément au choix de migration validé. La migration est additive et ne supprime aucune colonne existante.

## Sécurité et intégrité

- Le frontend n'est jamais la source de vérité pour le taux ou les montants HT/TVA.
- Le serveur recalcule les valeurs à partir du produit, de la quantité et du TTC résolu côté serveur.
- Le taux est figé au moment de la création/modification de la ligne, puis préservé à l'archivage.
- Les calculs utilisent des centimes entiers dans la logique métier ; les valeurs décimales ne sont converties qu'à l'entrée/sortie de la base et de l'API.

## Vérification prévue

- création et édition de produits pour chacun des taux `5,5 %`, `10 %`, `20 %` ;
- exemple pizza `10,00 € TTC` à `10 %` donnant `9,09 € HT` et `0,91 € TVA` ;
- commande mixte contenant plusieurs taux, avec une ventilation correcte par taux ;
- supplément/personnalisation utilisant le taux du produit principal ;
- modification ultérieure du taux du produit sans impact sur une commande ou archive existante ;
- archive d'une commande conservant exactement les mêmes snapshots ;
- checkout Stripe conservant exactement le même montant TTC ;
- tests backend ciblés, lint frontend et build frontend/backoffice approprié.
