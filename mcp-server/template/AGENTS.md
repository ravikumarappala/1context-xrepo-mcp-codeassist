# Acme workspace rules (all coding assistants)

## How the repos fit together
- web-portal calls orders-api and inventory-service, signs users in through auth-lambda,
  and uses upload-kit for attachments.
- orders-api owns the orders API. Its contract is the source of truth for clients.
- auth-lambda and upload-kit are REUSABLE: changes affect every consumer in the catalog.

## Before writing code
1. Call `find_reuse`. Extend a reusable service before creating a new one.
2. Load `get_expert_pack` for the stack you are editing.
3. Check `search_knowledge` for past decisions and known bugs.

## Changing more than one repo
1. `create_plan` first (one branch name for every repo). Order: shared library -> backend -> client.
2. Backend changes stay backward compatible (add fields; don't rename or remove) until clients have moved.
3. Shared library API change -> version bump + CHANGELOG, then update consumers.

## Enhance, don't rewrite
- Match existing patterns. Propose better ones in the plan or a decision record; don't apply them silently.

## Before finishing or switching tools
- `run_check` for every repo you changed.
- `update_plan`: what changed, where you stopped, what is next.
- `record_learning` for any non-obvious bug or fix.

## Never
- Commit secrets, .env files or infrastructure state.
- Hand-edit generated API clients.
