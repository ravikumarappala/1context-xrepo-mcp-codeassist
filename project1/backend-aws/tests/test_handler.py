import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import handler  # noqa: E402


class InventoryTests(unittest.TestCase):
    def setUp(self):
        handler.STOCK.update({"sku-100": 12, "sku-200": 0})

    def call(self, method, sku, body=None):
        r = handler.handler({"httpMethod": method, "pathParameters": {"sku": sku}, "body": json.dumps(body) if body else None})
        return r["statusCode"], json.loads(r["body"])

    def test_get_stock(self):
        self.assertEqual(self.call("GET", "sku-100"), (200, {"sku": "sku-100", "available": 12}))

    def test_reserve(self):
        status, body = self.call("POST", "sku-100", {"quantity": 2})
        self.assertEqual((status, body["available"]), (200, 10))

    def test_reserve_too_many(self):
        self.assertEqual(self.call("POST", "sku-200", {"quantity": 1})[0], 409)

    def test_unknown_sku(self):
        self.assertEqual(self.call("GET", "nope")[0], 404)


if __name__ == "__main__":
    unittest.main()
