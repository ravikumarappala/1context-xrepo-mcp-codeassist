"""inventory-service: stock levels and reservations. Runs as an AWS Lambda behind API Gateway."""
import json

# In-memory stock so the sample runs offline. A real service would use a database.
STOCK = {"sku-100": 12, "sku-200": 0, "sku-300": 5}


def _resp(status, body):
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(body)}


def handler(event, _context=None):
    method = event.get("httpMethod")
    sku = (event.get("pathParameters") or {}).get("sku")
    if sku not in STOCK:
        return _resp(404, {"error": "unknown sku"})
    if method == "GET":
        return _resp(200, {"sku": sku, "available": STOCK[sku]})
    if method == "POST":  # reserve stock for an order
        qty = int(json.loads(event.get("body") or "{}").get("quantity", 1))
        if qty < 1 or qty > STOCK[sku]:
            return _resp(409, {"error": "not enough stock", "available": STOCK[sku]})
        STOCK[sku] -= qty
        return _resp(200, {"sku": sku, "reserved": qty, "available": STOCK[sku]})
    return _resp(405, {"error": "method not allowed"})
