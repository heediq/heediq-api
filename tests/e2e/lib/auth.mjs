// Shared token provisioning for the real-stack E2E suite (D-156, closes the D-147 backlog item
// "a shared token-provisioning helper — both smokes currently take a hand-provisioned ID_TOKEN").
//
// Two ways to get the Cognito **ID** token every smoke needs (the ID token carries custom:orgId/
// custom:role/custom:accountId; the access token does not):
//   1. Explicit override — ID_TOKEN=<token>  or  TOKEN_FILE=/path/to/token  (unchanged, back-compat).
//   2. Provision — sign a seeded dev test user in via Cognito USER_PASSWORD_AUTH (ROPC) and take the
//      IdToken. This is what CI and `pnpm e2e` use so no human has to paste a token.
//
// Provisioning needs (all env):
//   COGNITO_CLIENT_ID      the app client id (public SPA client, no secret) with USER_PASSWORD_AUTH enabled
//   TEST_USER_EMAIL        a pre-created, CONFIRMED dev user with a PERMANENT password
//   TEST_USER_PASSWORD     that user's password
//   AWS_REGION | COGNITO_REGION   the region the user pool lives in (defaults to eu-west-1)
//
// The test user must already exist and be fully confirmed with a permanent password — provisioning
// deliberately does NOT create users or answer NEW_PASSWORD_REQUIRED (that would need admin creds and
// belongs in a one-off setup script, not the per-run token path). It's a raw HTTPS call to the public
// Cognito IDP endpoint, so it needs no AWS credentials — only the client id + the user's own password.
import { readFileSync } from 'node:fs'

const REGION = process.env.AWS_REGION ?? process.env.COGNITO_REGION ?? 'eu-west-1'

/** Resolve a Cognito ID token: explicit override if present, else provision from the seeded test user. */
export async function resolveIdToken() {
  const override = process.env.ID_TOKEN ?? (process.env.TOKEN_FILE && readFileSync(process.env.TOKEN_FILE, 'utf8'))
  if (override) return override.trim()
  return provisionIdToken()
}

/** Sign the seeded dev test user in via USER_PASSWORD_AUTH and return the IdToken. */
export async function provisionIdToken() {
  const clientId = req('COGNITO_CLIENT_ID')
  const username = req('TEST_USER_EMAIL')
  const password = req('TEST_USER_PASSWORD')

  const res = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  })

  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const type = body.__type ?? res.status
    const message = body.message ?? JSON.stringify(body)
    fatal(`Cognito InitiateAuth failed (${type}): ${message}`)
  }
  if (body.ChallengeName) {
    fatal(
      `Cognito returned challenge ${body.ChallengeName} — the E2E test user must be a CONFIRMED user ` +
        `with a PERMANENT password (no forced reset). Fix the seeded user, don't handle it here.`,
    )
  }
  const idToken = body.AuthenticationResult?.IdToken
  if (!idToken) fatal('Cognito InitiateAuth returned no IdToken.')
  return idToken
}

function req(name) {
  const v = process.env[name]
  if (!v) {
    fatal(
      `Missing required env ${name}. Provide ID_TOKEN/TOKEN_FILE to use an explicit token, or ` +
        `COGNITO_CLIENT_ID + TEST_USER_EMAIL + TEST_USER_PASSWORD to provision one.`,
    )
  }
  return v
}

function fatal(message) {
  console.error(message)
  process.exit(2)
}
