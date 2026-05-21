### `Build with`

- [bcrypt](https://www.npmjs.com/package/bcrypt)
- [body-parser](https://www.npmjs.com/package/body-parser)
- [dotenv](https://www.npmjs.com/package/dotenv)
- [expressjs](https://www.npmjs.com/package/express)
- [jsonwebtoken](https://www.npmjs.com/package/jsonwebtoken)
- [multer](https://www.npmjs.com/package/multer)
- [mysql2](https://www.npmjs.com/package/mysql2)
- [node-mailjet](https://www.npmjs.com/package/node-mailjet)
- [nodemon](https://www.npmjs.com/package/nodemon)

### `Installing`

Clone project

```
git clone https://github.com/tomimandalap/pos.git
```

```
npm install
```

or

```
yarn install
```

### `Starting`

Decrypt the committed **.env.local** file before running this application.

```
  npm run hooks:install

  APP_ENV=local
  ENV_FILE=.env.local
  NODE_ENV=local
  PORT=5005
  DATABASE_URL=mysql://root:@localhost:3306/pointofsale
  JWTKEY=
  EMAIL=
  MAILAPIKEY=
  MAILSECRETKEY=
  PATHURL=http://localhost:3000
  PUBLICIMAGEPATH="/home/smarteat/public"
  STRIPE_SECRET_KEY=
  STRIPE_PUBLISHABLE_KEY=
  STRIPE_WEBHOOK_SECRET=
  STRIPE_CONNECT_RETURN_URL=http://localhost:8083/settings
  STRIPE_CONNECT_REFRESH_URL=http://localhost:8083/settings
  STRIPE_COMMISSION_PERCENT=5
  STRIPE_PAYMENT_METHOD_CONFIGURATION_ID=

  Note:
  * Read the guide https://www.npmjs.com/package/node-mailjet and create an account https://www.mailjet.com/
  * PATHURL is the Nuxt frontend URL.
  * DATABASE_URL is used for the app database connection and local migrations.
  * .env.local, .env.staging and .env.production are committed encrypted and decrypted locally by the Git hooks.

```

To start use

```
npm run start
```

or

```
yarn start
```

---

Pour changer de variable d'environnement, il faut soit modifier NODE_ENV avant l'execuction de index.js, renseigner ENV_FILE, ou alors ecosystem.config.js.
-installer docker

- passer le user de VM en admin
  =====> script pour installer docker

sudo apt update
sudo apt install -y ca-certificates curl

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${UBUNTU_CODENAME:-$VERSION_CODENAME}) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
=== >start docker
====> metter docker en admin
sudo usermod -aG docker $USER
