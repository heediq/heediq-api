import { randomInt } from 'node:crypto'
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ResendConfirmationCodeCommand,
  ConfirmSignUpCommand,
  AdminSetUserPasswordCommand,
  AdminLinkProviderForUserCommand,
  AdminCreateUserCommand,
  ListUsersCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider'
import { config } from '../config.js'

export const cognitoClient = new CognitoIdentityProviderClient({ region: config.cognito.region })

// Creates a native `UNCONFIRMED` Cognito user and triggers Cognito's own confirmation-code
// email — no app code touches SES for this (D-087). The password is a throwaway; the real
// one is set later via adminSetUserPassword once the code is confirmed.
export function signUp(email: string, password: string) {
  return cognitoClient.send(new SignUpCommand({
    ClientId: config.cognito.clientId,
    Username: email,
    Password: password,
    UserAttributes: [{ Name: 'email', Value: email }],
  }))
}

export function resendConfirmationCode(email: string) {
  return cognitoClient.send(new ResendConfirmationCodeCommand({
    ClientId: config.cognito.clientId,
    Username: email,
  }))
}

export function confirmSignUp(email: string, code: string) {
  return cognitoClient.send(new ConfirmSignUpCommand({
    ClientId: config.cognito.clientId,
    Username: email,
    ConfirmationCode: code,
  }))
}

export function adminSetUserPassword(username: string, password: string) {
  return cognitoClient.send(new AdminSetUserPasswordCommand({
    UserPoolId: config.cognito.userPoolId,
    Username: username,
    Password: password,
    Permanent: true,
  }))
}

// Links an existing federated identity (Google/Microsoft sub) onto the native user that just
// confirmed a password — the two previously-separate `sub`s become one linked identity.
export function adminLinkProviderForUser(nativeUsername: string, providerName: string, providerUserId: string) {
  return cognitoClient.send(new AdminLinkProviderForUserCommand({
    UserPoolId: config.cognito.userPoolId,
    DestinationUser: { ProviderName: 'Cognito', ProviderAttributeValue: nativeUsername },
    SourceUser: {
      ProviderName: providerName,
      ProviderAttributeName: 'Cognito_Subject',
      ProviderAttributeValue: providerUserId,
    },
  }))
}

export function adminCreateUser(email: string, temporaryPassword: string) {
  return cognitoClient.send(new AdminCreateUserCommand({
    UserPoolId: config.cognito.userPoolId,
    Username: email,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
    ],
    MessageAction: 'SUPPRESS',
    TemporaryPassword: temporaryPassword,
  }))
}

export async function listUsersByEmail(email: string): Promise<UserType[]> {
  const result = await cognitoClient.send(new ListUsersCommand({
    UserPoolId: config.cognito.userPoolId,
    Filter: `email = "${email}"`,
    Limit: 10,
  }))
  return result.Users ?? []
}

export function getUserAttribute(user: UserType, name: string): string | undefined {
  return user.Attributes?.find((a) => a.Name === name)?.Value
}

export function isExternalProviderUser(user: UserType): boolean {
  return user.UserStatus === 'EXTERNAL_PROVIDER'
}

// The `identities` attribute is Cognito's JSON-serialized record of the federated IdP this
// user signed in through — present only on EXTERNAL_PROVIDER users, absent on native ones.
export function getProviderContext(user: UserType): { providerName: string; providerUserId: string } | null {
  const raw = getUserAttribute(user, 'identities')
  if (!raw) return null
  let identities: unknown
  try {
    identities = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(identities) || identities.length === 0) return null
  const first = identities[0] as { providerName?: unknown; userId?: unknown }
  if (typeof first.providerName === 'string' && typeof first.userId === 'string') {
    return { providerName: first.providerName, providerUserId: first.userId }
  }
  return null
}

// Never presented to a real user — either a SignUp throwaway (replaced by the user's chosen
// password on confirm) or an AdminCreateUser temp password (replaced on the user's next admin
// reset). Must satisfy the pool's password policy (upper/lower/digit/symbol, D-020).
export function randomPassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let core = ''
  for (let i = 0; i < 20; i++) core += alphabet[randomInt(alphabet.length)]
  return `Aa9!${core}`
}
