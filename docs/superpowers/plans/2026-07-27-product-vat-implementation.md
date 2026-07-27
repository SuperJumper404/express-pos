# TVA par produit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter une TVA TTC par produit, figée dans les lignes de commande et affichée correctement dans les détails et tickets.

**Architecture:** Le backend reste la seule source de vérité : `vat_rate` vient du produit, puis le moteur de devis calcule des snapshots HT/TVA en centimes. Checkout, édition et archivage ne manipulent ensuite que ces snapshots. Le frontend choisit le taux dans les formulaires produit et présente uniquement une ventilation de données déjà calculées par l'API.

**Tech Stack:** Express, mysql2, dbmate, Node assert tests, Nuxt 2, Vue 2, Vuetify, jsPDF.

---

## Structure cible

### Backend — `express-pos`

- Create: `src/helpers/vat.js` — validation des taux et calculs TTC/HT/TVA en centimes.
- Create: `test/vat.test.js` — contrats unitaires de calcul et validation des taux.
- Create: `db/migrations/<timestamp>_add_product_vat_snapshots.sql` — colonnes produit/lignes et backfill à 10 %.
- Modify: `src/controllers/c_products.js` — normalisation et rejet d'un taux invalide.
- Modify: `src/modules/m_orderQuote.js` — enrichissement des items résolus avec snapshots TVA.
- Modify: `src/modules/m_checkout.js` — persistance des snapshots à la création.
- Modify: `src/modules/m_orderEditing.js` — persistance des snapshots à la modification.
- Modify: `src/modules/m_orders.js` — copie des snapshots lors de l'archivage et ventilation par taux à la lecture.
- Modify: `test/checkout-contract.test.js` and `test/order-editing.test.js` — couverture du taux figé et des écritures de ligne.
- Modify: `test/customization-migration.test.js` — assertions de migration pour les nouvelles colonnes.
- Modify: `package.json` — exécuter `test/vat.test.js` dans `npm test`.

### Frontend — `pos-app`

- Modify: `pages/products/newproduct.vue` — choix du taux et envoi FormData de `vat_rate`.
- Modify: `pages/products/edit/_id/index.vue` — préremplissage, édition et envoi de `vat_rate`.
- Create: `helpers/vat.js` — regroupement d'une réponse de détail par taux, sans recalculer les montants métier.
- Create: `components/orders/VatBreakdown.vue` — tableau réutilisable HT / TVA / TTC par taux.
- Modify: `components/orders/OrderDetailList.vue` (ou le composant actif de détail) — montage de la ventilation dans le détail caisse.
- Modify: `pages/history/ticket/_id.vue` — remplacement de la TVA fixe à 20 % par la ventilation API pour HTML, ESC/POS et PDF.
- Modify: `pages/receip.vue` — même ventilation pour le reçu de caisse.
- Create: `test/vat-breakdown.test.js` — contrat du regroupement et du rendu des données reçues.

### Contrat de ligne API

Chaque item résolu et chaque détail persistant porte ces propriétés :

```js
{
  unitPrice: 10.00,       // TTC
  lineTotal: 20.00,       // TTC
  vatRate: 10.00,
  unitPriceHt: 9.09,
  unitVat: 0.91,
  totalHt: 18.18,
  totalVat: 1.82
}
```

Les noms SQL correspondants restent en snake_case (`vat_rate`, `unit_price_ht`, `unit_vat`, `total_ht`, `total_vat`). L'API peut conserver le format SQL existant des détails ; le frontend lira donc les noms retournés par le backend au lieu d'inventer un deuxième calcul.

### Algorithme fiscal unique

`src/helpers/vat.js` expose :

```js
const ALLOWED_VAT_RATES = [5.5, 10, 20];

const normalizeVatRate = (value, fallback = 10) => {
  const parsed = Number(value == null || value === '' ? fallback : value);
  if (!ALLOWED_VAT_RATES.includes(parsed)) {
    throw new Error('VAT_RATE_INVALID');
  }
  return parsed;
};

const buildVatSnapshot = ({ unitPrice, quantity, vatRate }) => {
  const rate = normalizeVatRate(vatRate);
  const unitTtcCents = Math.round(Number(unitPrice) * 100);
  const totalTtcCents = unitTtcCents * Number(quantity);
  const divisor = 10000 + Math.round(rate * 100);
  const totalHtCents = Math.round((totalTtcCents * 10000) / divisor);
  const totalVatCents = totalTtcCents - totalHtCents;
  const unitHtCents = Math.round((unitTtcCents * 10000) / divisor);
  const unitVatCents = unitTtcCents - unitHtCents;

  return {
    vatRate: rate,
    unitPriceHt: unitHtCents / 100,
    unitVat: unitVatCents / 100,
    totalHt: totalHtCents / 100,
    totalVat: totalVatCents / 100,
  };
};
```

La valeur TTC existante reste inchangée. `totalVat` est toujours défini comme `lineTotal - totalHt`, ce qui garantit l'égalité TTC = HT + TVA après arrondi.

### Ordre de déploiement

1. Déployer le backend et appliquer la migration avant de déployer le frontend.
2. Vérifier que les produits et commandes existants se lisent avec le taux historique de 10 %.
3. Déployer le frontend seulement après disponibilité des nouvelles colonnes/API.

---

### Task 1: Verrouiller les calculs TVA purs

**Files:**
- Create: `src/helpers/vat.js`
- Create: `test/vat.test.js`
- Modify: `package.json`

- [ ] **Step 1: Écrire les assertions de contrat TVA**

```js
const assert = require('assert');
const { buildVatSnapshot, normalizeVatRate } = require('../src/helpers/vat');

assert.deepStrictEqual(buildVatSnapshot({ unitPrice: 10, quantity: 1, vatRate: 10 }), {
  vatRate: 10,
  unitPriceHt: 9.09,
  unitVat: 0.91,
  totalHt: 9.09,
  totalVat: 0.91,
});
assert.deepStrictEqual(buildVatSnapshot({ unitPrice: 1.05, quantity: 2, vatRate: 5.5 }), {
  vatRate: 5.5,
  unitPriceHt: 1,
  unitVat: 0.05,
  totalHt: 1.99,
  totalVat: 0.11,
});
assert.throws(() => normalizeVatRate(8), /VAT_RATE_INVALID/);
```

- [ ] **Step 2: Exécuter le test en échec**

Run: `node test/vat.test.js`

Expected: échec car `src/helpers/vat.js` n'existe pas encore.

- [ ] **Step 3: Implémenter le helper unique**

Créer `src/helpers/vat.js` avec `ALLOWED_VAT_RATES`, `normalizeVatRate` et `buildVatSnapshot` selon l'algorithme ci-dessus. Ne pas importer Stripe ni la base de données dans ce helper.

- [ ] **Step 4: Ajouter le test à la suite backend**

Ajouter `node test/vat.test.js` après les tests unitaires existants dans le script `test` de `package.json`.

- [ ] **Step 5: Vérifier le test vert**

Run: `node test/vat.test.js`

Expected: `vat tests passed` et code 0.

- [ ] **Step 6: Commit**

```bash
git add src/helpers/vat.js test/vat.test.js package.json
git commit -m "feat: add VAT calculation helper"
```

### Task 2: Ajouter le schéma et le backfill historique

**Files:**
- Create: `db/migrations/<timestamp>_add_product_vat_snapshots.sql`
- Modify: `test/customization-migration.test.js`

- [ ] **Step 1: Ajouter les attentes de migration**

Ajouter dans `test/customization-migration.test.js` les marqueurs SQL :

```js
'ADD COLUMN `vat_rate` DECIMAL(4,2) NOT NULL DEFAULT 10.00',
'ADD COLUMN `unit_price_ht` DECIMAL(12,2) NOT NULL DEFAULT 0.00',
'ADD COLUMN `unit_vat` DECIMAL(12,2) NOT NULL DEFAULT 0.00',
'ADD COLUMN `total_ht` DECIMAL(12,2) NOT NULL DEFAULT 0.00',
'ADD COLUMN `total_vat` DECIMAL(12,2) NOT NULL DEFAULT 0.00',
```

- [ ] **Step 2: Exécuter le test en échec**

Run: `node test/customization-migration.test.js`

Expected: échec car la migration TVA n'est pas encore présente.

- [ ] **Step 3: Créer la migration additive**

Écrire une migration dbmate qui :

```sql
ALTER TABLE products ADD COLUMN vat_rate DECIMAL(4,2) NOT NULL DEFAULT 10.00 AFTER price;
ALTER TABLE orderdetail ADD COLUMN vat_rate DECIMAL(4,2) NOT NULL DEFAULT 10.00 AFTER total;
ALTER TABLE orderdetail ADD COLUMN unit_price_ht DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER vat_rate;
ALTER TABLE orderdetail ADD COLUMN unit_vat DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER unit_price_ht;
ALTER TABLE orderdetail ADD COLUMN total_ht DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER unit_vat;
ALTER TABLE orderdetail ADD COLUMN total_vat DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_ht;
```

Répéter les cinq colonnes de snapshot pour `archivesdetail`, puis backfiller les deux tables en 10 % à partir de `price`, `qty` et `total`. Le `migrate:down` supprime uniquement les colonnes ajoutées, dans l'ordre inverse.

- [ ] **Step 4: Vérifier la migration statiquement et localement**

Run: `node test/customization-migration.test.js`

Expected: succès.

Run: `npm run db:up:local`

Expected: dbmate applique exactement une migration TVA, sans modifier les totaux TTC existants.

- [ ] **Step 5: Commit**

```bash
git add db/migrations test/customization-migration.test.js
git commit -m "feat: persist product VAT snapshots"
```

### Task 3: Propager le taux dans le devis, le checkout et l'édition

**Files:**
- Modify: `src/modules/m_orderQuote.js`
- Modify: `src/modules/m_checkout.js`
- Modify: `src/modules/m_orderEditing.js`
- Modify: `test/checkout-contract.test.js`
- Modify: `test/order-editing.test.js`

- [ ] **Step 1: Ajouter des assertions de lignes persistées**

Dans les harnesses de checkout et d'édition, faire retourner un produit avec `vat_rate: 5.5`, puis vérifier les objets passés à `insertOrderDetail` :

```js
assert.deepStrictEqual(insertedDetail, {
  orderid: 500,
  productid: 10,
  price: 10,
  qty: 2,
  total: 20,
  vat_rate: 5.5,
  unit_price_ht: 9.48,
  unit_vat: 0.52,
  total_ht: 18.96,
  total_vat: 1.04,
});
```

- [ ] **Step 2: Exécuter les tests en échec**

Run: `node test/checkout-contract.test.js && node test/order-editing.test.js`

Expected: assertions TVA absentes des détails persistés.

- [ ] **Step 3: Enrichir le moteur de devis**

Dans `m_orderQuote.js`, importer `buildVatSnapshot`, appeler le helper après le calcul de `unitPrice`/`lineTotal` et ajouter le snapshot à chaque `resolvedItem`. Le taux est obtenu via `product.vat_rate` et normalisé avec le défaut `10` pour compatibilité.

Mettre également `vat_rate`, `total_ht` et `total_vat` dans `serverQuote.items` afin que le contrat de devis présente les mêmes valeurs que le détail persistant.

- [ ] **Step 4: Persister strictement les snapshots du devis**

Dans `m_checkout.js` et `m_orderEditing.js`, étendre l'objet envoyé à `insertOrderDetail` :

```js
vat_rate: item.vatRate,
unit_price_ht: item.unitPriceHt,
unit_vat: item.unitVat,
total_ht: item.totalHt,
total_vat: item.totalVat,
```

Ne jamais prendre ces valeurs depuis le corps HTTP. Conserver le champ `total` TTC tel quel et ne modifier aucune conversion Stripe.

- [ ] **Step 5: Vérifier les contrats**

Run: `node test/checkout-contract.test.js && node test/order-editing.test.js`

Expected: succès, y compris le cas Stripe qui garde son total TTC de 20 €.

- [ ] **Step 6: Commit**

```bash
git add src/modules/m_orderQuote.js src/modules/m_checkout.js src/modules/m_orderEditing.js test/checkout-contract.test.js test/order-editing.test.js
git commit -m "feat: snapshot VAT on order lines"
```

### Task 4: Valider et exposer le taux produit

**Files:**
- Modify: `src/controllers/c_products.js`
- Modify: `src/modules/m_products.js`
- Modify: `test/checkout-contract.test.js`

- [ ] **Step 1: Ajouter les contrats de validation produit**

Ajouter des tests de contrôleur ou de normalisation couvrant : taux absent → `10`, taux `5.5`/`10`/`20` acceptés, taux `0`, `8` et `20.1` rejetés avec `VAT_RATE_INVALID`.

- [ ] **Step 2: Exécuter la couverture ciblée en échec**

Run: `node test/checkout-contract.test.js`

Expected: échec tant que le contrôleur accepte un taux arbitraire ou omet la valeur par défaut.

- [ ] **Step 3: Normaliser côté contrôleur**

Dans les chemins create/update de `c_products.js`, appeler `normalizeVatRate(req.body.vat_rate, 10)` avant de construire les données envoyées à `m_products`. Le module produit persiste simplement la valeur normalisée avec les autres champs.

- [ ] **Step 4: Vérifier les taux admis et les rejets**

Run: `node test/checkout-contract.test.js`

Expected: succès ; les valeurs hors liste n'atteignent jamais la base.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/c_products.js src/modules/m_products.js test/checkout-contract.test.js
git commit -m "feat: validate product VAT rates"
```

### Task 5: Préserver les snapshots lors de l'archivage et fournir la ventilation

**Files:**
- Modify: `src/modules/m_orders.js`
- Modify: `test/checkout-contract.test.js`

- [ ] **Step 1: Écrire le contrat d'archive**

Ajouter un cas d'archive avec une ligne préexistante :

```js
{
  price: 10,
  qty: 1,
  total: 10,
  vat_rate: 10,
  unit_price_ht: 9.09,
  unit_vat: 0.91,
  total_ht: 9.09,
  total_vat: 0.91,
}
```

Vérifier que l'objet transmis à `insertArchiveDetail` contient exactement les mêmes valeurs, même si le produit joint a été changé à 20 %.

- [ ] **Step 2: Exécuter le test en échec**

Run: `node test/checkout-contract.test.js`

Expected: échec si l'archive reconstruit les détails avec la valeur actuelle du produit ou omet les colonnes snapshot.

- [ ] **Step 3: Copier les données fiscales existantes**

Dans le chemin transactionnel d'archivage de `m_orders.js`, étendre l'objet `detail` passé à `insertArchiveDetail` avec les cinq colonnes TVA depuis `orderdetail`. Ne pas utiliser `products.vat_rate` dans ce chemin.

Ajouter une fonction locale pure qui regroupe les détails par `vat_rate` et retourne :

```js
[{ vat_rate: 5.5, total_ht: 1.99, total_vat: 0.11, total_ttc: 2.10 }]
```

L'attacher aux réponses détaillées actives et archivées sous `vat_breakdown`.

- [ ] **Step 4: Vérifier archive et détail**

Run: `node test/checkout-contract.test.js`

Expected: succès ; la ventilation mixte somme toujours aux totaux TTC existants.

- [ ] **Step 5: Commit**

```bash
git add src/modules/m_orders.js test/checkout-contract.test.js
git commit -m "feat: preserve VAT in archives"
```

### Task 6: Ajouter le choix TVA aux formulaires produit

**Files:**
- Modify: `C:/Users/kalag/Desktop/projects/clone-pos/pos/pos-app/pages/products/newproduct.vue`
- Modify: `C:/Users/kalag/Desktop/projects/clone-pos/pos/pos-app/pages/products/edit/_id/index.vue`

- [ ] **Step 1: Déclarer le modèle formulaire**

Ajouter `vat_rate: 10` aux objets `formproduct` et `formeditproduct`. À l'hydratation d'édition, utiliser :

```js
vat_rate: Number(product.vat_rate || 10),
```

- [ ] **Step 2: Ajouter le groupe radio exclusif sous `Prix TTC`**

Insérer dans chaque formulaire :

```vue
<v-radio-group v-model="formproduct.vat_rate" label="Taux de TVA" row>
  <v-radio label="5,5 %" :value="5.5" />
  <v-radio label="10 %" :value="10" />
  <v-radio label="20 %" :value="20" />
</v-radio-group>
<div class="text-caption grey--text">Le prix saisi est TTC.</div>
```

Adapter seulement le nom de modèle en édition (`formeditproduct`).

- [ ] **Step 3: Inclure le champ dans chaque payload**

Ajouter `fd.append('vat_rate', this.formproduct.vat_rate)` au `FormData` de création et `vat_rate: this.formeditproduct.vat_rate` à `buildProductPayload()` pour l'édition.

- [ ] **Step 4: Vérifier statiquement les formulaires**

Run: `npm run lint:js -- pages/products/newproduct.vue pages/products/edit/_id/index.vue`

Expected: code 0 pour ces deux fichiers.

- [ ] **Step 5: Commit frontend**

```bash
git add pages/products/newproduct.vue pages/products/edit/_id/index.vue
git commit -m "feat: select VAT rate per product"
```

### Task 7: Afficher la ventilation dans le détail et les tickets

**Files:**
- Create: `C:/Users/kalag/Desktop/projects/clone-pos/pos/pos-app/helpers/vat.js`
- Create: `C:/Users/kalag/Desktop/projects/clone-pos/pos/pos-app/components/orders/VatBreakdown.vue`
- Modify: `C:/Users/kalag/Desktop/projects/clone-pos/pos/pos-app/components/orders/OrderDetailList.vue`
- Modify: `C:/Users/kalag/Desktop/projects/clone-pos/pos/pos-app/pages/history/ticket/_id.vue`
- Modify: `C:/Users/kalag/Desktop/projects/clone-pos/pos/pos-app/pages/receip.vue`
- Create: `C:/Users/kalag/Desktop/projects/clone-pos/pos/pos-app/test/vat-breakdown.test.js`
- Modify: `C:/Users/kalag/Desktop/projects/clone-pos/pos/pos-app/package.json`

- [ ] **Step 1: Écrire le contrat frontend sans calcul métier**

```js
const assert = require('assert');
const { normalizeVatBreakdown } = require('../helpers/vat');

assert.deepStrictEqual(normalizeVatBreakdown([
  { vat_rate: 10, total_ht: 9.09, total_vat: 0.91, total: 10 },
]), [{ vatRate: 10, totalHt: 9.09, totalVat: 0.91, totalTtc: 10 }]);
```

- [ ] **Step 2: Créer le helper et le composant de présentation**

`normalizeVatBreakdown` doit prioriser `response.vat_breakdown` si présent, puis seulement adapter les noms snake_case/camelCase. Il ne recalcule jamais le HT ou la TVA à partir du taux.

`VatBreakdown.vue` accepte `items` et rend une ligne par taux avec les libellés `HT`, `TVA` et `TTC`, en réutilisant le formatter prix existant.

- [ ] **Step 3: Brancher l'écran de détail et les reçus**

Afficher `VatBreakdown` uniquement lorsque `activate_tva` est vrai. Dans `ticket/_id.vue` et `receip.vue`, remplacer les sorties littérales `TVA (20%)` par une boucle sur les lignes de ventilation pour les trois canaux HTML/PDF/ESC-POS.

- [ ] **Step 4: Ajouter le test au script frontend et vérifier**

Run: `node test/vat-breakdown.test.js`

Expected: succès.

Run: `npm run lint:js -- helpers/vat.js components/orders/VatBreakdown.vue components/orders/OrderDetailList.vue pages/history/ticket/_id.vue pages/receip.vue`

Expected: code 0 pour les fichiers modifiés.

- [ ] **Step 5: Commit frontend**

```bash
git add helpers/vat.js components/orders/VatBreakdown.vue components/orders/OrderDetailList.vue pages/history/ticket/_id.vue pages/receip.vue test/vat-breakdown.test.js package.json
git commit -m "feat: display VAT breakdown on orders"
```

### Task 8: Vérification intégrée et préparation staging

**Files:**
- Modify: uniquement les fichiers révélant un défaut concret pendant les vérifications.

- [ ] **Step 1: Lancer toute la suite backend**

Run: `npm test`

Expected: tous les contrats checkout, Stripe, archivage, personnalisation et TVA passent.

- [ ] **Step 2: Lancer toute la suite frontend**

Run: `npm test`

Expected: les tests existants et `vat-breakdown.test.js` passent.

- [ ] **Step 3: Construire le frontend**

Run: `npm run build-local`

Expected: build Nuxt terminé sans erreur de compilation.

- [ ] **Step 4: Appliquer la migration sur la base locale et faire un smoke test**

Run: `npm run db:up:local`

Expected: aucune migration restante ou migration TVA appliquée avec succès.

Créer/éditer un produit pizza `10,00 €`, taux `10 %`, puis vérifier par API ou détail de commande que la ligne stocke `9,09 € HT`, `0,91 € TVA`, `10,00 € TTC`.

- [ ] **Step 5: Vérifier l'ordre de publication**

Préparer les deux branches `staging`, pousser d'abord le backend, appliquer la migration via le workflow backend staging, puis pousser/déployer le frontend staging. Ne pas publier en production sans validation utilisateur explicite.

## Auto-revue

- Couverture spec : les taux, TTC, snapshots, migration à 10 %, checkout, édition, archivage, Stripe, formulaires, détail et ticket sont chacun reliés à une tâche.
- Aucun placeholder opérationnel : chaque tâche indique fichiers, commande et résultat attendu.
- Cohérence des noms : `vat_rate`, `unit_price_ht`, `unit_vat`, `total_ht`, `total_vat` sont les noms SQL uniques ; leurs équivalents camelCase ne vivent que dans les objets internes frontend/backend.
