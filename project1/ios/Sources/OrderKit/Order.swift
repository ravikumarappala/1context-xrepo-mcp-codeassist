import Foundation

/// Mirrors the Order schema in project1/backend-gcp/contracts/openapi.yaml. Change the contract first.
public struct Order: Codable, Equatable {
    public struct Item: Codable, Equatable {
        public let sku: String
        public let quantity: Int
    }
    public let orderId: String
    public let status: String
    public let total: Double
    public let items: [Item]

    enum CodingKeys: String, CodingKey {
        case orderId = "order_id", status, total, items
    }
}
