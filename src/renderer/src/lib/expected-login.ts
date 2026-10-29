import type { Account, AccountIdentity, ExpectedLogin } from '@shared/types'

/** The expected login in the shape of an identity, e.g. to show it before the account is logged in. */
export function expectedIdentity(expected: ExpectedLogin): AccountIdentity {
  return {
    email: expected.email,
    displayName: null,
    organizationUuid: expected.organizationUuid,
    organizationName: expected.organizationName,
    organizationType: null,
    subscriptionType: null,
    rateLimitTier: null,
  }
}

/** Logged in, but as another person or organization than the account is meant for. */
export function isUnexpectedLogin(account: Account): boolean {
  const expected = account.expectedLogin
  const { email, organizationUuid } = account.identity
  if (!expected || account.authState === 'missing' || !email) return false
  if (email.toLowerCase() !== expected.email.toLowerCase()) return true
  return !!expected.organizationUuid && !!organizationUuid && organizationUuid !== expected.organizationUuid
}
