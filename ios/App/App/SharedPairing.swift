import Foundation
import Security

struct CompanionPairing: Codable {
    let origin: URL
    let token: String
}

enum SharedPairing {
    // Cookie name is defined in src/main/companion/server.ts.
    static let cookieName = "cp_companion"
    private static let service = "com.cujuju.chattypop.companion"
    private static let account = "paired-phone"

    private static func query() throws -> [String: Any] {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "SharedKeychainGroup") as? String,
              !group.isEmpty, !group.contains("$(") else {
            throw PairingError.configuration
        }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
                kSecAttrAccessGroup as String: group]
    }

    static func read() throws -> CompanionPairing? {
        var request = try query()
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw PairingError.keychain(status) }
        let pairing = try JSONDecoder().decode(CompanionPairing.self, from: data)
        guard pairing.origin.scheme == "https", pairing.origin.host != nil,
              pairing.origin.user == nil, pairing.origin.password == nil,
              !pairing.token.isEmpty else { throw PairingError.configuration }
        return pairing
    }

    static func write(_ pairing: CompanionPairing?) throws {
        let request = try query()
        guard let pairing else {
            let status = SecItemDelete(request as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw PairingError.keychain(status) }
            return
        }
        let values: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(pairing),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        var status = SecItemUpdate(request as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(request.merging(values) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PairingError.keychain(status) }
    }

    enum PairingError: Error {
        case configuration
        case keychain(OSStatus)
    }
}
