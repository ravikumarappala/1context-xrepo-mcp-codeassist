import Foundation

/// Text for the order summary card in the iOS app.
public struct OrderSummaryViewModel: Equatable {
    public let title: String
    public let status: String
    public let detail: String

    public init(order: Order) {
        let labels = ["processing": "Processing", "shipped": "On its way", "delivered": "Delivered", "cancelled": "Cancelled"]
        let count = order.items.reduce(0) { $0 + $1.quantity }
        title = "Order \(order.orderId)"
        status = labels[order.status] ?? order.status
        detail = "\(count) item\(count == 1 ? "" : "s") · $\(String(format: "%.2f", order.total))"
    }
}
