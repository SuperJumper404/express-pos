#!/bin/sh
set -eu

app_container=${1:?Live application container is required}
mysql_container=${2:?MySQL container is required}
migrations_dir=${3:?Absolute migrations directory is required}
test -d "$migrations_dir"

mysql_uuid=$(docker exec "$mysql_container" sh -euc '
  MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot --protocol=socket --batch --skip-column-names -e "SELECT @@server_uuid"
')
test -n "$mysql_uuid"

database_path=$(docker exec --env EXPECTED_MYSQL_UUID="$mysql_uuid" "$app_container" node -e '
  const mysql = require("mysql2/promise");
  (async () => {
    const connection = await mysql.createConnection(process.env.DATABASE_URL);
    try {
      const [[database]] = await connection.query("SELECT DATABASE() AS name, @@server_uuid AS uuid");
      if (!database.name || database.uuid !== process.env.EXPECTED_MYSQL_UUID) {
        throw new Error("The live application is not connected to the selected MySQL container");
      }
      process.stdout.write(encodeURIComponent(database.name));
    } finally {
      await connection.end();
    }
  })().catch(error => {
    console.error("Cannot identify the migration database:", error.code || error.message);
    process.exitCode = 1;
  });
')
test -n "$database_path"

# Send the password via stdin instead of putting it in Docker arguments.
# Sharing MySQL's network namespace lets dbmate authenticate from loopback.
migrate=$(cat <<'SH'
encoded_password=$(od -An -v -tx1 | awk '{for (i=1; i<=NF; i++) printf "%%%s", $i}')
test -n "$encoded_password"
export DATABASE_URL="mysql://root:$encoded_password@127.0.0.1:3306/$MIGRATION_DATABASE_PATH"
exec dbmate --no-dump-schema --migrations-dir /db/migrations migrate
SH
)

docker exec "$mysql_container" sh -euc 'test -n "$MYSQL_ROOT_PASSWORD"; printf "%s" "$MYSQL_ROOT_PASSWORD"' |
  docker run --rm -i --network "container:$mysql_container" \
    --mount "type=bind,source=$migrations_dir,target=/db/migrations,readonly" \
    --env MIGRATION_DATABASE_PATH="$database_path" --entrypoint /bin/sh \
    ghcr.io/amacneil/dbmate:2.31.0 -euc "$migrate"
