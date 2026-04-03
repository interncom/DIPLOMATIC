# USER

The USER endpoint registers a new user.

## Request

### USER Request Data Structure

|Field|Bytes|Encoding|
|-----|-----|--------|
|authTS|101-104|[see docs](./host#authts-data-structure)|

When the payment mechanism is implemented, USER requests may include a payment token to subscribe or add credits to an account.

## Response

The response status code indicates whether the user was successfully registered.

A USER response has no other contents.
