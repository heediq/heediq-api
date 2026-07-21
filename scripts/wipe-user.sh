#!/usr/bin/env bash
# Local dev util — not committed (see .git/info/exclude).
# Fully wipes a dev user from Cognito AND DynamoDB so login + account-linking
# can be retested from a clean slate (unlike reset-email-login.sh, which only
# resets the email/password method).
#
# Deletes, per D-099's identity model:
#   - the Cognito User Pool user
#   - heediq-users row (by-email GSI lookup)
#   - heediq-cognito-identities rows (every sub -> accountId mapping for this user)
#   - heediq-user-auth-methods rows (all METHOD#/EVENT# rows under USER#<accountId>)
#   - heediq-auth-audit-log rows (all pk=USER#<accountId> rows)
#
# Usage: ./scripts/wipe-user.sh <email>

set -euo pipefail

EMAIL="${1:?Usage: $0 <email>}"
PROFILE="heediq-dev"
USERS_TABLE="heediq-users"
IDENTITIES_TABLE="heediq-cognito-identities"
METHODS_TABLE="heediq-user-auth-methods"
AUDIT_TABLE="heediq-auth-audit-log"

USER_POOL_ID=$(aws ssm get-parameter \
  --name "/heediq/api/cognito-user-pool-id" \
  --profile "$PROFILE" \
  --query 'Parameter.Value' \
  --output text)

USER_ID=$(aws dynamodb query \
  --table-name "$USERS_TABLE" \
  --index-name by-email \
  --key-condition-expression "email = :e" \
  --expression-attribute-values "{\":e\": {\"S\": \"$EMAIL\"}}" \
  --profile "$PROFILE" \
  --query 'Items[0].userId.S' \
  --output text)

if [[ -z "$USER_ID" || "$USER_ID" == "None" ]]; then
  echo "No user found for $EMAIL in $USERS_TABLE" >&2
  USER_ID=""
else
  echo "Found accountId $USER_ID for $EMAIL"
fi

echo "Deleting Cognito user $EMAIL from pool $USER_POOL_ID..."
aws cognito-idp admin-delete-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --profile "$PROFILE" 2>/dev/null \
  && echo "  Cognito user deleted." \
  || echo "  No Cognito user found for $EMAIL (skipping)."

if [[ -n "$USER_ID" ]]; then
  echo "Deleting $USERS_TABLE row..."
  aws dynamodb delete-item \
    --table-name "$USERS_TABLE" \
    --key "{\"userId\": {\"S\": \"$USER_ID\"}}" \
    --profile "$PROFILE"

  echo "Deleting $IDENTITIES_TABLE rows (sub -> $USER_ID)..."
  aws dynamodb scan \
    --table-name "$IDENTITIES_TABLE" \
    --filter-expression "accountId = :a" \
    --expression-attribute-values "{\":a\": {\"S\": \"$USER_ID\"}}" \
    --profile "$PROFILE" \
    --query 'Items[].sub.S' \
    --output text | tr '\t' '\n' | while read -r sub; do
      [[ -z "$sub" ]] && continue
      echo "  Deleting identity sub=$sub"
      aws dynamodb delete-item \
        --table-name "$IDENTITIES_TABLE" \
        --key "{\"sub\": {\"S\": \"$sub\"}}" \
        --profile "$PROFILE"
    done

  echo "Deleting $METHODS_TABLE rows (pk=USER#$USER_ID)..."
  aws dynamodb query \
    --table-name "$METHODS_TABLE" \
    --key-condition-expression "pk = :p" \
    --expression-attribute-values "{\":p\": {\"S\": \"USER#$USER_ID\"}}" \
    --profile "$PROFILE" \
    --query 'Items[].sk.S' \
    --output text | tr '\t' '\n' | while read -r sk; do
      [[ -z "$sk" ]] && continue
      echo "  Deleting method row sk=$sk"
      aws dynamodb delete-item \
        --table-name "$METHODS_TABLE" \
        --key "{\"pk\": {\"S\": \"USER#$USER_ID\"}, \"sk\": {\"S\": \"$sk\"}}" \
        --profile "$PROFILE"
    done

  echo "Deleting $AUDIT_TABLE rows (pk=USER#$USER_ID)..."
  aws dynamodb query \
    --table-name "$AUDIT_TABLE" \
    --key-condition-expression "pk = :p" \
    --expression-attribute-values "{\":p\": {\"S\": \"USER#$USER_ID\"}}" \
    --profile "$PROFILE" \
    --query 'Items[].sk.S' \
    --output text | tr '\t' '\n' | while read -r sk; do
      [[ -z "$sk" ]] && continue
      echo "  Deleting audit row sk=$sk"
      aws dynamodb delete-item \
        --table-name "$AUDIT_TABLE" \
        --key "{\"pk\": {\"S\": \"USER#$USER_ID\"}, \"sk\": {\"S\": \"$sk\"}}" \
        --profile "$PROFILE"
    done
else
  echo "No DynamoDB user row — only Cognito cleanup was possible."
fi

echo "Done. $EMAIL fully wiped from Cognito and DynamoDB."
