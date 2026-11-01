import XCTest
@testable import OrderKit

final class OrderKitTests: XCTestCase {
    func testDecodesContractShapeAndBuildsSummary() throws {
        let json = #"{"order_id":"o-1001","status":"shipped","total":42.5,"items":[{"sku":"sku-100","quantity":2}]}"#
        let order = try JSONDecoder().decode(Order.self, from: Data(json.utf8))
        let vm = OrderSummaryViewModel(order: order)
        XCTAssertEqual(vm.title, "Order o-1001")
        XCTAssertEqual(vm.status, "On its way")
        XCTAssertEqual(vm.detail, "2 items · $42.50")
    }
}
