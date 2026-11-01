# orders-api (backend on GCP)

Node service on Cloud Run: `GET /orders/{id}` for the signed-in user. Contract: `contracts/openapi.yaml`.
Uses the reusable `auth-lib`. Consumed by `frontend-web` and `ios-app`; calls `inventory-service`.
Run: `npm start`. Test: `npm test`.
