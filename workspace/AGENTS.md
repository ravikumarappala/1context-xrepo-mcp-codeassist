# Acme workspace rules (shared by every AI assistant)

1. Contract first: change `contracts/openapi.yaml` before any implementation, then update every consumer
   listed by `get_service` (web and iOS read the same Order shape).
2. Before writing new code, call `find_reuse`. Auth goes through `auth-lib`; never write a new token check.
3. Authorize by the signed-in user's token, never by an ID in the URL.
4. Changes across folders: `create_plan` first, one branch name, release order:
   shared library -> backend (backward compatible) -> clients.
5. Run `run_check` for every folder you changed.
6. Before stopping or switching tools: `update_plan` with what changed, where you stopped, what's next.
