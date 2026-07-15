import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PreTokenGenerationTriggerHandler } from 'aws-lambda'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../../src/lib/dynamo.js'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import { handler } from '../../src/handlers/auth-provision.js'
import { seedFullOrg, seedIdentity, type IntegrationTables } from './seed.js'

const tables: IntegrationTables = {
  orgsTable: 'heediq-orgs',
  usersTable: 'heediq-users',
  cognitoIdentitiesTable: 'heediq-cognito-identities',
  rolesTable: 'heediq-roles',
  groupsTable: 'heediq-groups',
  roleAssignmentsTable: 'heediq-role-assignments',
}

type Event = Parameters<PreTokenGenerationTriggerHandler>[0]

function makeEvent(overrides: {
  sub: string
  email: string
  identities?: { providerName: string; userId: string }[]
}): Event {
  return {
    version: '1',
    region: 'eu-west-1',
    userPoolId: 'local-pool',
    userName: overrides.sub,
    callerContext: { awsSdkVersion: 'test', clientId: 'local-client' },
    triggerSource: 'TokenGeneration_Authentication',
    request: {
      userAttributes: {
        sub: overrides.sub,
        email: overrides.email,
        ...(overrides.identities ? { identities: JSON.stringify(overrides.identities) } : {}),
      },
      groupConfiguration: { groupsToOverride: [] },
    },
    response: {},
  } as unknown as Event
}

describe('auth-provision handler (integration, DynamoDB Local)', () => {
  it('provisions a brand-new org for a native (email/password) first login', async () => {
    const sub = randomUUID()
    const email = `${randomUUID()}@newco.com`
    const event = await handler(makeEvent({ sub, email }), undefined as never, undefined as never)

    const claims = event!.response.claimsOverrideDetails!.claimsToAddOrOverride!
    expect(claims['custom:role']).toBe('admin')
    expect(JSON.parse(claims['custom:permissions'] as string).sort()).toEqual(
      [...DEFAULT_ORG_RBAC_SEED.admin.permissions].sort(),
    )

    const accountId = claims['custom:accountId'] as string
    const orgId = claims['custom:orgId'] as string

    const [org, user, identity, authMethod] = await Promise.all([
      dynamo.send(new GetCommand({ TableName: tables.orgsTable, Key: { orgId } })),
      dynamo.send(new GetCommand({ TableName: tables.usersTable, Key: { userId: accountId } })),
      dynamo.send(new GetCommand({ TableName: tables.cognitoIdentitiesTable, Key: { sub } })),
      dynamo.send(new GetCommand({
        TableName: 'heediq-user-auth-methods',
        Key: { pk: `USER#${accountId}`, sk: 'METHOD#COGNITO' },
      })),
    ])

    expect(org.Item).toBeDefined()
    expect(user.Item?.['passwordSet']).toBe(true)
    expect(identity.Item?.['accountId']).toBe(accountId)
    expect(authMethod.Item?.['provider']).toBe('COGNITO')
  })

  it('provisions a brand-new org for a federated (Google) first login, marking passwordSet false', async () => {
    const sub = `Google_${randomUUID()}`
    const email = `${randomUUID()}@newco.com`
    const event = await handler(
      makeEvent({ sub, email, identities: [{ providerName: 'Google', userId: sub }] }),
      undefined as never,
      undefined as never,
    )

    const claims = event!.response.claimsOverrideDetails!.claimsToAddOrOverride!
    const accountId = claims['custom:accountId'] as string
    const user = await dynamo.send(new GetCommand({ TableName: tables.usersTable, Key: { userId: accountId } }))
    expect(user.Item?.['passwordSet']).toBe(false)

    const authMethod = await dynamo.send(new GetCommand({
      TableName: 'heediq-user-auth-methods',
      Key: { pk: `USER#${accountId}`, sk: 'METHOD#GOOGLE' },
    }))
    expect(authMethod.Item?.['provider']).toBe('Google')
  })

  it('resolves an existing user deterministically via the identities table (D-099)', async () => {
    const { orgId, adminUserId } = await seedFullOrg(tables)
    const sub = randomUUID()
    await seedIdentity(tables, sub, adminUserId)

    const event = await handler(
      makeEvent({ sub, email: 'admin@existing.com' }),
      undefined as never,
      undefined as never,
    )
    const claims = event!.response.claimsOverrideDetails!.claimsToAddOrOverride!
    expect(claims['custom:accountId']).toBe(adminUserId)
    expect(claims['custom:orgId']).toBe(orgId)
    expect(claims['custom:role']).toBe('admin')
    expect(JSON.parse(claims['custom:permissions'] as string).sort()).toEqual(
      [...DEFAULT_ORG_RBAC_SEED.admin.permissions].sort(),
    )
  })

  it('self-heals via email lookup when no identity mapping exists yet, then persists the mapping', async () => {
    const email = `${randomUUID()}@selfheal.com`
    const { orgId, adminUserId } = await seedFullOrg(tables, { email })

    const newSub = randomUUID()
    const event = await handler(makeEvent({ sub: newSub, email }), undefined as never, undefined as never)
    const claims = event!.response.claimsOverrideDetails!.claimsToAddOrOverride!
    expect(claims['custom:accountId']).toBe(adminUserId)
    expect(claims['custom:orgId']).toBe(orgId)

    const identity = await dynamo.send(new GetCommand({ TableName: tables.cognitoIdentitiesTable, Key: { sub: newSub } }))
    expect(identity.Item?.['accountId']).toBe(adminUserId)
  })
})
