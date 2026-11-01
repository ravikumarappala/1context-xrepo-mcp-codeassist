# 0001 Contract-first API between orders-api and its clients

Status: accepted

## Context
Field names drifted between the API docs and the web portal's client code.

## Decision
orders-api/contracts/openapi.yaml is the source of truth. The API validates against it; the portal's client is
generated from it. Changes go contract -> API (backward compatible) -> clients.

## Consequences
- Breaking changes surface at build time.
- Removing a field takes two releases (expand, then contract).
