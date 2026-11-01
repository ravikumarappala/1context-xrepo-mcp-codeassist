# inventory-service (backend on AWS)

Python Lambda: `GET /stock/{sku}` and `POST /stock/{sku}` (reserve). Contract: `contracts/openapi.yaml`.
Consumed by `orders-api`. Test: `python3 -m unittest discover -s tests`.
