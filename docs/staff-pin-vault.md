# Staff PIN consultation

Staff login still verifies `staff_pin_hash` with bcrypt. An independent encrypted
copy in `users.staff_pin_encrypted` lets a current, same-shop administrator consult
a PIN through `GET /user/:id/staff-credentials`. Lists and login responses do not
include this copy. The primary administrator's credentials remain excluded.

## Server configuration

Set `PIN_ENCRYPTION_KEY` to an independently generated, cryptographically random
32-byte key encoded as base64. Keep it server-side only, in the backend environment
or secret manager, never in Nuxt configuration, source control or logs. All backend
instances sharing a database must use the same key. Back it up securely alongside
the database recovery procedure, but not in the same publicly accessible location.

Apply `20261024120000_staff_pin_vault.sql` before running this application version
and restart the backend after configuring its environment. Docker Compose already
loads the selected backend environment through `env_file`.

The local Docker database has been backed up and migrated. A local-only key was
generated in `.env.local`; staging and production have not been configured or
deployed by this change.

## Existing credentials

Existing bcrypt hashes cannot recover the original PIN. Existing staff accounts
continue to sign in normally. On consultation they return `needs_regeneration`;
an administrator must explicitly generate a new PIN once using the key button in
Equipe. This changes the login PIN and creates both its hash and encrypted copy.
New staff accounts are immediately consultable after creation.

No existing account is reset by the migration. Kiosk credential storage is
unchanged; encrypting its existing plaintext copies is a separate migration.

## Failure and recovery

Missing or invalid keys prevent creation/regeneration before any credentials are
written. Existing encrypted copies cannot be read with a missing, changed or
incorrect key; the endpoint returns a generic error without resetting anything.
Bcrypt login does not depend on this key. Do not replace a configured key without
first planning an authenticated re-encryption of all stored copies. If the key is
lost, restore it from its secure backup or explicitly regenerate affected PINs.

The frontend fetches only when the administrator clicks the eye. The response is
`no-store`; revealed PINs stay in page memory, not Vuex or localStorage. Hiding,
leaving the route, refreshing the staff list or changing sessions clears them.
